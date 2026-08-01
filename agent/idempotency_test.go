package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestCommandResultCacheReplaysTerminalResult(t *testing.T) {
	cache := newCommandResultCache(2)
	cached, pending, owner, err := cache.begin("command-1")
	if err != nil {
		t.Fatal(err)
	}
	if cached != nil || pending == nil || !owner {
		t.Fatalf("first begin = (%v, %v, %v), want execution ownership", cached, pending, owner)
	}

	_, duplicatePending, duplicateOwner, err := cache.begin("command-1")
	if err != nil {
		t.Fatal(err)
	}
	if duplicatePending != pending || duplicateOwner {
		t.Fatal("in-flight duplicate did not wait on the original command")
	}
	want := commandResultMessage{Type: "command.completed", CommandID: "command-1", Output: "ok"}
	if err := cache.complete("command-1", want); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	got, ok := duplicatePending.wait(ctx)
	if !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("pending result = (%#v, %v), want %#v", got, ok, want)
	}

	cached, _, owner, err = cache.begin("command-1")
	if err != nil {
		t.Fatal(err)
	}
	if owner || cached == nil || !reflect.DeepEqual(*cached, want) {
		t.Fatalf("redelivery = (%#v, %v), want cached %#v", cached, owner, want)
	}
}

func TestCommandResultCacheIsBounded(t *testing.T) {
	cache := newCommandResultCache(2)
	for _, id := range []string{"one", "two", "three"} {
		_, _, owner, err := cache.begin(id)
		if err != nil {
			t.Fatal(err)
		}
		if !owner {
			t.Fatalf("begin(%q) did not grant ownership", id)
		}
		if err := cache.complete(id, commandResultMessage{Type: "command.failed", CommandID: id, Error: "failed"}); err != nil {
			t.Fatal(err)
		}
	}

	if cached, _, _, _ := cache.begin("two"); cached == nil {
		t.Fatal("second-newest result was evicted")
	}
	if cached, _, _, _ := cache.begin("three"); cached == nil {
		t.Fatal("newest result was evicted")
	}
	if cached, _, owner, _ := cache.begin("one"); cached != nil || !owner {
		t.Fatal("oldest result was not evicted from bounded cache")
	}
}

func TestCommandResultCachePersistsTerminalResultAcrossRestart(t *testing.T) {
	stateDir := secureTestStateDir(t)
	cache, err := openCommandResultCache(stateDir, "binding-1", maxCachedCommandResults)
	if err != nil {
		t.Fatal(err)
	}
	_, _, owner, err := cache.begin("command-1")
	if err != nil || !owner {
		t.Fatalf("begin() = owner %v, error %v", owner, err)
	}
	want := commandResultMessage{Type: "command.completed", CommandID: "command-1", Output: "players: 1"}
	if err := cache.complete("command-1", want); err != nil {
		t.Fatal(err)
	}

	restarted, err := openCommandResultCache(stateDir, "binding-1", maxCachedCommandResults)
	if err != nil {
		t.Fatal(err)
	}
	cached, _, owner, err := restarted.begin("command-1")
	if err != nil {
		t.Fatal(err)
	}
	if owner || cached == nil || !reflect.DeepEqual(*cached, want) {
		t.Fatalf("restart result = (%#v, owner %v), want %#v", cached, owner, want)
	}
	info, err := os.Stat(stateFilePath(stateDir, "binding-1"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode = %04o, want 0600", info.Mode().Perm())
	}
}

func TestCommandResultCacheMarksInterruptedCommandUnknown(t *testing.T) {
	stateDir := secureTestStateDir(t)
	cache, err := openCommandResultCache(stateDir, "binding-1", maxCachedCommandResults)
	if err != nil {
		t.Fatal(err)
	}
	_, _, owner, err := cache.begin("command-running")
	if err != nil || !owner {
		t.Fatalf("begin() = owner %v, error %v", owner, err)
	}

	restarted, err := openCommandResultCache(stateDir, "binding-1", maxCachedCommandResults)
	if err != nil {
		t.Fatal(err)
	}
	cached, _, owner, err := restarted.begin("command-running")
	if err != nil {
		t.Fatal(err)
	}
	if owner || cached == nil || cached.Type != "command.failed" || cached.Error != unknownOutcomeError {
		t.Fatalf("interrupted result = (%#v, owner %v), want unknown terminal failure", cached, owner)
	}

	restartedAgain, err := openCommandResultCache(stateDir, "binding-1", maxCachedCommandResults)
	if err != nil {
		t.Fatal(err)
	}
	cached, _, owner, err = restartedAgain.begin("command-running")
	if err != nil || owner || cached == nil || cached.Error != unknownOutcomeError {
		t.Fatalf("persisted unknown result = (%#v, owner %v, error %v)", cached, owner, err)
	}
}

func TestNewBindingAgentsFailsForInsecureStateDirectory(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(stateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := validTestConfig()
	cfg.StateDir = stateDir
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	_, err := newBindingAgents(cfg, logger)
	if err == nil || !strings.Contains(err.Error(), "binding-1") || !strings.Contains(err.Error(), "too open") {
		t.Fatalf("newBindingAgents() error = %v, want clear binding state error", err)
	}
}

func TestCommandResultCacheRejectsInsecureStateFile(t *testing.T) {
	stateDir := secureTestStateDir(t)
	if _, err := openCommandResultCache(stateDir, "binding-1", maxCachedCommandResults); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(stateFilePath(stateDir, "binding-1"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := openCommandResultCache(stateDir, "binding-1", maxCachedCommandResults)
	if err == nil || !strings.Contains(err.Error(), "0600") {
		t.Fatalf("openCommandResultCache() error = %v, want state permissions error", err)
	}
}

func TestJournalCursorPersistsAcrossRestart(t *testing.T) {
	stateDir := secureTestStateDir(t)
	cache, err := openCommandResultCache(stateDir, "binding-1", maxCachedCommandResults)
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.saveJournalCursor("s=cursor-1;i=2"); err != nil {
		t.Fatal(err)
	}

	restarted, err := openCommandResultCache(stateDir, "binding-1", maxCachedCommandResults)
	if err != nil {
		t.Fatal(err)
	}
	if got := restarted.journalCursor(); got != "s=cursor-1;i=2" {
		t.Fatalf("journalCursor() = %q, want persisted cursor", got)
	}
	info, err := os.Stat(cursorStateFilePath(stateDir, "binding-1"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("cursor state mode = %04o, want 0600", info.Mode().Perm())
	}
}

func secureTestStateDir(t *testing.T) string {
	t.Helper()
	stateDir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	return stateDir
}
