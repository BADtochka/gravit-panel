package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestLiveFilesystemOperationsStayInsideMarkedRoot(t *testing.T) {
	root := t.TempDir()
	binding := BindingConfig{ID: "binding-1", Root: root}
	if err := os.WriteFile(filepath.Join(root, ".gravit-panel-server"), []byte("binding-1\n"), 0o600); err != nil { t.Fatal(err) }
	if err := os.Mkdir(filepath.Join(root, ".gravit-panel"), 0o700); err != nil { t.Fatal(err) }
	if err := os.Mkdir(filepath.Join(root, "config"), 0o750); err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(root, "server.properties"), []byte("motd=Hello\n"), 0o640); err != nil { t.Fatal(err) }

	resolved, err := initializeFilesystemRoot(binding)
	if err != nil { t.Fatal(err) }
	listed, err := executeFilesystem(resolved, filesystemRequest{Operation: "list"})
	if err != nil { t.Fatal(err) }
	entries := listed.(map[string]any)["entries"].([]liveEntry)
	if len(entries) != 2 { t.Fatalf("entries = %v", entries) }

	if _, err := executeFilesystem(resolved, filesystemRequest{Operation: "read", Path: ".gravit-panel-server"}); err == nil { t.Fatal("hidden file was readable") }
	if _, err := executeFilesystem(resolved, filesystemRequest{Operation: "read", Path: "gravit-server.env"}); err == nil { t.Fatal("reserved file was readable") }

	data := base64.StdEncoding.EncodeToString([]byte("enabled=true\n"))
	if _, err := executeFilesystem(resolved, filesystemRequest{Operation: "write", Path: "config/example.toml", Data: data}); err != nil { t.Fatal(err) }
	if _, err := executeFilesystem(resolved, filesystemRequest{Operation: "move", SourcePath: "config/example.toml", DestinationPath: "config/renamed.toml"}); err != nil { t.Fatal(err) }
	if _, err := executeFilesystem(resolved, filesystemRequest{Operation: "delete", Paths: []string{"config/renamed.toml"}, Confirm: true}); err != nil { t.Fatal(err) }
	if _, err := os.Stat(filepath.Join(root, "config", "renamed.toml")); !os.IsNotExist(err) { t.Fatalf("deleted file stat error = %v", err) }
}

func TestLiveFilesystemRejectsSymlinksAndWrongMarker(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".gravit-panel-server"), []byte("other\n"), 0o600); err != nil { t.Fatal(err) }
	if _, err := initializeFilesystemRoot(BindingConfig{ID: "binding-1", Root: root}); err == nil { t.Fatal("wrong marker was accepted") }
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "escape")); err != nil { t.Fatal(err) }
	if _, err := safeLivePath(root, "escape/file.txt", false); err == nil { t.Fatal("symlink path was accepted") }
}
