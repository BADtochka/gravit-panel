package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const maxLiveTextBytes = 512 * 1024
const maxLiveTransferBytes = 256 * 1024 * 1024

var reservedLiveRoots = map[string]bool{
	"eula.txt": true, "serverwrapper.jar": true, "serverwrapperinline.jar": true,
	"serverwrapperconfig.json": true, "gravit-server.env": true,
	"start-gravit-server.sh": true, "server.jar": true, "fabric-server-launch.jar": true,
	"run.sh": true, "run.bat": true, "user_jvm_args.txt": true,
	"libraries": true, "versions": true,
}

type liveEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size *int64 `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
}

func initializeFilesystemRoot(binding BindingConfig) (string, error) {
	if binding.Root == "" { return "", nil }
	root, err := filepath.EvalSymlinks(binding.Root)
	if err != nil { return "", errors.New("resolve configured root") }
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() { return "", errors.New("configured root is not a directory") }
	marker, err := os.ReadFile(filepath.Join(root, ".gravit-panel-server"))
	if err != nil || strings.TrimSpace(string(marker)) != binding.ID { return "", errors.New("server root marker does not match binding") }
	return root, nil
}

func validateLivePath(value string, allowRoot bool) error {
	if value == "" && allowRoot { return nil }
	if value == "" || len(value) > 512 || filepath.IsAbs(value) || strings.ContainsAny(value, "\\\x00") { return errors.New("invalid path") }
	parts := strings.Split(value, "/")
	if len(parts) > 32 { return errors.New("path is too deep") }
	for index, part := range parts {
		if part == "" || part == "." || part == ".." || strings.HasPrefix(part, ".") || len(part) > 255 { return errors.New("invalid path component") }
		if index == 0 && reservedLiveRoots[strings.ToLower(part)] { return errors.New("path is reserved") }
	}
	return nil
}

func safeLivePath(root, value string, allowRoot bool) (string, error) {
	if err := validateLivePath(value, allowRoot); err != nil { return "", err }
	target := filepath.Join(root, filepath.FromSlash(value))
	current := root
	parts := strings.Split(value, "/")
	for index, part := range parts {
		if part == "" { continue }
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) { break }
		if err != nil { return "", errors.New("inspect path") }
		if info.Mode()&os.ModeSymlink != 0 { return "", errors.New("symbolic links are forbidden") }
		if index < len(parts)-1 && !info.IsDir() { return "", errors.New("path parent is not a directory") }
	}
	return target, nil
}

func fsFailure(id, code, message string) filesystemResponse { return filesystemResponse{Type:"fs.response", RequestID:id, OK:false, Error:&filesystemError{Code:code, Message:message}} }

func (a *bindingAgent) handleFilesystem(request filesystemRequest) filesystemResponse {
	if a.filesystemRoot == "" { return fsFailure(request.ID, "UNAVAILABLE", "Live filesystem is unavailable") }
	if request.ID == "" || request.BindingID != a.config.ID { return fsFailure(request.ID, "INVALID_REQUEST", "Invalid filesystem request") }
	result, err := executeFilesystem(a.filesystemRoot, request)
	if err != nil { return fsFailure(request.ID, "IO_ERROR", err.Error()) }
	return filesystemResponse{Type:"fs.response", RequestID:request.ID, OK:true, Result:result}
}

func executeFilesystem(root string, request filesystemRequest) (any, error) {
	switch request.Operation {
	case "list":
		target, err := safeLivePath(root, request.Path, true); if err != nil { return nil, err }
		items, err := os.ReadDir(target); if err != nil { return nil, errors.New("directory is unavailable") }
		if len(items) > 500 { items = items[:500] }
		entries := make([]liveEntry, 0, len(items))
		for _, item := range items {
			name := item.Name(); if strings.HasPrefix(name, ".") || (request.Path == "" && reservedLiveRoots[strings.ToLower(name)]) { continue }
			info, err := item.Info(); if err != nil || info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) { continue }
			path := strings.TrimPrefix(request.Path+"/"+name, "/")
			var size *int64; kind := "directory"; if info.Mode().IsRegular() { value := info.Size(); size=&value; kind="file" }
			entries = append(entries, liveEntry{Path:path, Type:kind, Size:size, ModifiedAt:info.ModTime().UTC().Format(time.RFC3339Nano)})
		}
		sort.Slice(entries, func(i,j int) bool { if entries[i].Type != entries[j].Type { return entries[i].Type == "directory" }; return entries[i].Path < entries[j].Path })
		return map[string]any{"path":request.Path,"entries":entries}, nil
	case "read":
		target, err := safeLivePath(root, request.Path, false); if err != nil { return nil, err }
		info, err := os.Lstat(target); if err != nil || !info.Mode().IsRegular() { return nil, errors.New("file is unavailable") }
		maxBytes := int64(maxLiveTextBytes)
		if request.MaxBytes > 0 && request.MaxBytes < maxBytes { maxBytes = request.MaxBytes }
		if info.Size() > maxBytes { return nil, fmt.Errorf("file exceeds %d bytes", maxBytes) }
		data, err := os.ReadFile(target); if err != nil { return nil, errors.New("read file") }
		digest := sha256.Sum256(data)
		return map[string]any{"path":request.Path,"data":base64.StdEncoding.EncodeToString(data),"size":len(data),"sha256":hex.EncodeToString(digest[:]),"modifiedAt":info.ModTime().UTC().Format(time.RFC3339Nano)}, nil
	case "write":
		target, err := safeLivePath(root, request.Path, false); if err != nil { return nil, err }
		data, err := base64.StdEncoding.Strict().DecodeString(request.Data)
		maxBytes := int64(maxLiveTransferBytes)
		if request.MaxBytes > 0 && request.MaxBytes < maxBytes { maxBytes = request.MaxBytes }
		if err != nil { return nil, errors.New("file data is not valid base64") }
		if int64(len(data)) > maxBytes { return nil, fmt.Errorf("file exceeds %d MiB", maxBytes/(1024*1024)) }
		if !request.Overwrite { if _, err := os.Lstat(target); err == nil { return nil, errors.New("destination already exists") } }
		if info, err := os.Lstat(filepath.Dir(target)); err != nil || !info.IsDir() { return nil, errors.New("parent directory is unavailable") }
		temp, err := os.CreateTemp(filepath.Dir(target), ".gravit-fs-"); if err != nil { return nil, errors.New("create temporary file") }
		tempName:=temp.Name(); defer os.Remove(tempName)
		if _,err=temp.Write(data); err==nil { err=temp.Sync() }; closeErr:=temp.Close(); if err==nil { err=closeErr }; if err!=nil { return nil, errors.New("write file") }
		if err=os.Chmod(tempName,0640); err!=nil { return nil, errors.New("set file permissions") }; if err=os.Rename(tempName,target); err!=nil { return nil, errors.New("replace file") }
		return map[string]any{"paths":[]string{request.Path}},nil
	case "mkdir":
		target, err := safeLivePath(root, request.Path, false); if err != nil { return nil, err }; if err=os.Mkdir(target,0750); err!=nil { return nil, errors.New("create directory") }; return map[string]any{"paths":[]string{request.Path}},nil
	case "move":
		source,err:=safeLivePath(root,request.SourcePath,false);if err!=nil{return nil,err};destination,err:=safeLivePath(root,request.DestinationPath,false);if err!=nil{return nil,err};if strings.HasPrefix(destination,source+string(os.PathSeparator)){return nil,errors.New("cannot move directory into itself")};if _,err=os.Lstat(destination);err==nil{return nil,errors.New("destination already exists")};if err=os.Rename(source,destination);err!=nil{return nil,errors.New("move entry")};return map[string]any{"paths":[]string{request.DestinationPath}},nil
	case "delete":
		if !request.Confirm || len(request.Paths)==0 || len(request.Paths)>100{return nil,errors.New("confirmed paths are required")};trash:=filepath.Join(root,".gravit-panel","trash");if err:=os.MkdirAll(trash,0700);err!=nil{return nil,errors.New("prepare trash")};for _,path:=range request.Paths{source,err:=safeLivePath(root,path,false);if err!=nil{return nil,err};destination:=filepath.Join(trash,fmt.Sprintf("%d-%s",time.Now().UnixNano(),filepath.Base(source)));if err=os.Rename(source,destination);err!=nil{return nil,errors.New("move entry to trash")}};return map[string]any{"paths":request.Paths},nil
	default:return nil,errors.New("unsupported filesystem operation")
	}
}
