package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
)

const (
	maxCachedCommandResults = 4096
	maxJournalCursorBytes   = 4096
	commandStateVersion     = 1
	cursorStateVersion      = 1
	commandStatusAccepted   = "accepted"
	commandStatusTerminal   = "terminal"
	unknownOutcomeError     = "agent restarted before the command outcome was recorded; outcome unknown"
)

type commandResultCache struct {
	mu         sync.Mutex
	limit      int
	bindingID  string
	statePath  string
	cursorPath string
	cursor     string
	completed  map[string]commandResultMessage
	order      []string
	pending    map[string]*pendingCommandResult
}

type pendingCommandResult struct {
	done      chan struct{}
	result    commandResultMessage
	updatedAt string
}

type persistedCommandState struct {
	Version   int                     `json:"version"`
	BindingID string                  `json:"bindingId"`
	Commands  []persistedCommandEntry `json:"commands"`
}

type persistedCommandEntry struct {
	CommandID string                `json:"commandId"`
	Status    string                `json:"status"`
	Result    *commandResultMessage `json:"result,omitempty"`
	UpdatedAt string                `json:"updatedAt"`
}

type persistedCursorState struct {
	Version   int    `json:"version"`
	BindingID string `json:"bindingId"`
	Cursor    string `json:"cursor"`
}

func newCommandResultCache(limit int) *commandResultCache {
	return makeCommandResultCache(limit, "", "")
}

func openCommandResultCache(stateDir, bindingID string, limit int) (*commandResultCache, error) {
	if err := prepareStateDirectory(stateDir); err != nil {
		return nil, err
	}
	statePath := stateFilePath(stateDir, bindingID)
	cache := makeCommandResultCache(limit, bindingID, statePath)
	cache.cursorPath = cursorStateFilePath(stateDir, bindingID)
	if err := cache.load(); err != nil {
		return nil, err
	}
	if err := cache.loadCursor(); err != nil {
		return nil, err
	}
	cache.mu.Lock()
	err := cache.persistLocked()
	if err == nil {
		err = cache.persistCursorLocked()
	}
	cache.mu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("initialize state file: %w", err)
	}
	return cache, nil
}

func makeCommandResultCache(limit int, bindingID, statePath string) *commandResultCache {
	if limit < 1 {
		limit = 1
	}
	return &commandResultCache{
		limit:     limit,
		bindingID: bindingID,
		statePath: statePath,
		completed: make(map[string]commandResultMessage, limit),
		pending:   make(map[string]*pendingCommandResult),
	}
}

func prepareStateDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create stateDir: %w", err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("stat stateDir: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("stateDir must be a real directory, not a symlink")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("stateDir permissions %04o are too open; remove group and world access", info.Mode().Perm())
	}
	return nil
}

// begin durably records acceptance before granting execution ownership.
func (c *commandResultCache) begin(commandID string) (*commandResultMessage, *pendingCommandResult, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if result, ok := c.completed[commandID]; ok {
		return &result, nil, false, nil
	}
	if pending, ok := c.pending[commandID]; ok {
		return nil, pending, false, nil
	}
	pending := &pendingCommandResult{done: make(chan struct{}), updatedAt: timestamp()}
	c.pending[commandID] = pending
	if err := c.persistLocked(); err != nil {
		delete(c.pending, commandID)
		return nil, nil, false, fmt.Errorf("persist accepted command: %w", err)
	}
	return nil, pending, true, nil
}

func (c *commandResultCache) complete(commandID string, result commandResultMessage) error {
	c.mu.Lock()
	pending, ok := c.pending[commandID]
	if ok {
		delete(c.pending, commandID)
		pending.result = result
	}
	if _, exists := c.completed[commandID]; !exists {
		c.order = append(c.order, commandID)
	}
	c.completed[commandID] = result
	c.trimLocked()
	err := c.persistLocked()
	if ok {
		close(pending.done)
	}
	c.mu.Unlock()
	if err != nil {
		return fmt.Errorf("persist terminal command: %w", err)
	}
	return nil
}

func (p *pendingCommandResult) wait(ctx context.Context) (commandResultMessage, bool) {
	select {
	case <-ctx.Done():
		return commandResultMessage{}, false
	case <-p.done:
		return p.result, true
	}
}

func (c *commandResultCache) journalCursor() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cursor
}

func (c *commandResultCache) saveJournalCursor(cursor string) error {
	if cursor == "" {
		return nil
	}
	if len(cursor) > maxJournalCursorBytes {
		return fmt.Errorf("journal cursor exceeds %d bytes", maxJournalCursorBytes)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if cursor == c.cursor {
		return nil
	}
	previous := c.cursor
	c.cursor = cursor
	if err := c.persistCursorLocked(); err != nil {
		c.cursor = previous
		return fmt.Errorf("persist journal cursor: %w", err)
	}
	return nil
}

func (c *commandResultCache) load() error {
	data, err := readSecureStateFile(c.statePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read state file: %w", err)
	}
	var state persistedCommandState
	if err := decodeStrictJSON(data, &state); err != nil {
		return fmt.Errorf("decode state file: %w", err)
	}
	if state.Version != commandStateVersion {
		return fmt.Errorf("unsupported state version %d", state.Version)
	}
	if state.BindingID != c.bindingID {
		return fmt.Errorf("state bindingId %q does not match %q", state.BindingID, c.bindingID)
	}
	seen := make(map[string]struct{}, len(state.Commands))
	for _, entry := range state.Commands {
		if entry.CommandID == "" {
			return errors.New("state contains an empty commandId")
		}
		if _, exists := seen[entry.CommandID]; exists {
			return fmt.Errorf("state contains duplicate commandId %q", entry.CommandID)
		}
		seen[entry.CommandID] = struct{}{}
		var result commandResultMessage
		switch entry.Status {
		case commandStatusAccepted:
			result = commandResultMessage{Type: "command.failed", CommandID: entry.CommandID, Error: unknownOutcomeError}
		case commandStatusTerminal:
			if entry.Result == nil || entry.Result.CommandID != entry.CommandID || (entry.Result.Type != "command.completed" && entry.Result.Type != "command.failed") {
				return fmt.Errorf("state contains invalid terminal result for commandId %q", entry.CommandID)
			}
			result = *entry.Result
		default:
			return fmt.Errorf("state contains invalid status %q", entry.Status)
		}
		c.completed[entry.CommandID] = result
		c.order = append(c.order, entry.CommandID)
	}
	c.trimLocked()
	return nil
}

func (c *commandResultCache) loadCursor() error {
	data, err := readSecureStateFile(c.cursorPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read cursor state file: %w", err)
	}
	var state persistedCursorState
	if err := decodeStrictJSON(data, &state); err != nil {
		return fmt.Errorf("decode cursor state file: %w", err)
	}
	if state.Version != cursorStateVersion {
		return fmt.Errorf("unsupported cursor state version %d", state.Version)
	}
	if state.BindingID != c.bindingID {
		return fmt.Errorf("cursor state bindingId %q does not match %q", state.BindingID, c.bindingID)
	}
	if len(state.Cursor) > maxJournalCursorBytes {
		return fmt.Errorf("stored journal cursor exceeds %d bytes", maxJournalCursorBytes)
	}
	c.cursor = state.Cursor
	return nil
}

func readSecureStateFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("state file must be a regular file, not a symlink")
	}
	if info.Mode().Perm() != 0o600 {
		return nil, fmt.Errorf("state file permissions %04o are invalid; use 0600", info.Mode().Perm())
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) {
		return nil, errors.New("state file changed while opening")
	}
	return io.ReadAll(file)
}

func (c *commandResultCache) trimLocked() {
	for len(c.order) > c.limit {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.completed, oldest)
	}
}

func (c *commandResultCache) persistLocked() error {
	if c.statePath == "" {
		return nil
	}
	state := persistedCommandState{Version: commandStateVersion, BindingID: c.bindingID}
	state.Commands = make([]persistedCommandEntry, 0, len(c.order)+len(c.pending))
	for _, commandID := range c.order {
		result := c.completed[commandID]
		state.Commands = append(state.Commands, persistedCommandEntry{
			CommandID: commandID,
			Status:    commandStatusTerminal,
			Result:    &result,
			UpdatedAt: timestamp(),
		})
	}
	pendingIDs := make([]string, 0, len(c.pending))
	for commandID := range c.pending {
		pendingIDs = append(pendingIDs, commandID)
	}
	sort.Strings(pendingIDs)
	for _, commandID := range pendingIDs {
		state.Commands = append(state.Commands, persistedCommandEntry{
			CommandID: commandID,
			Status:    commandStatusAccepted,
			UpdatedAt: c.pending[commandID].updatedAt,
		})
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return atomicWriteState(c.statePath, data)
}

func (c *commandResultCache) persistCursorLocked() error {
	if c.cursorPath == "" {
		return nil
	}
	state := persistedCursorState{Version: cursorStateVersion, BindingID: c.bindingID, Cursor: c.cursor}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return atomicWriteState(c.cursorPath, data)
}

func atomicWriteState(path string, data []byte) error {
	directory := filepath.Dir(path)
	temp, err := os.CreateTemp(directory, ".state-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	removeTemp := true
	defer func() {
		_ = temp.Close()
		if removeTemp {
			_ = os.Remove(tempPath)
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temp.Write(data); err != nil {
		return err
	}
	if err := temp.Sync(); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	removeTemp = false
	dir, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func stateFilePath(stateDir, bindingID string) string {
	return filepath.Join(stateDir, bindingStatePrefix(bindingID)+".json")
}

func cursorStateFilePath(stateDir, bindingID string) string {
	return filepath.Join(stateDir, bindingStatePrefix(bindingID)+".cursor.json")
}

func bindingStatePrefix(bindingID string) string {
	hash := sha256.Sum256([]byte(bindingID))
	return "binding-" + hex.EncodeToString(hash[:])
}
