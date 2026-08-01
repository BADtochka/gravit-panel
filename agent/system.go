package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const (
	commandTimeout   = 30 * time.Second
	maxOutputBytes   = 64 * 1024
	maxCommandBytes  = 1000
	journalTailLines = 200
)

func runSystemctl(ctx context.Context, action, unit string) (string, error) {
	if !validUnitName(unit) {
		return "", fmt.Errorf("invalid configured unit %q", unit)
	}
	if action != "start" && action != "stop" && action != "restart" {
		return "", fmt.Errorf("unsupported systemctl action %q", action)
	}
	commandCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()

	cmd := exec.CommandContext(commandCtx, "systemctl", action, "--", unit)
	output, err := cappedCombinedOutput(cmd, maxOutputBytes)
	if commandCtx.Err() != nil {
		return output, fmt.Errorf("systemctl %s timed out", action)
	}
	if err != nil {
		if detail := strings.TrimSpace(output); detail != "" {
			return output, fmt.Errorf("systemctl %s: %w: %s", action, err, detail)
		}
		return output, fmt.Errorf("systemctl %s: %w", action, err)
	}
	return output, nil
}

func queryStatus(ctx context.Context, unit string) runtimeStatus {
	status := runtimeStatus{State: "unknown", SubState: "unknown", UpdatedAt: timestamp()}
	if !validUnitName(unit) {
		return status
	}
	statusCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(statusCtx, "systemctl", "show", "--property=ActiveState,SubState,MainPID", "--", unit)
	output, err := cappedCombinedOutput(cmd, 16*1024)
	if err != nil {
		return status
	}
	for _, line := range strings.Split(output, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key {
		case "ActiveState":
			status.State = value
		case "SubState":
			status.SubState = value
		case "MainPID":
			status.MainPID, _ = strconv.Atoi(value)
		}
	}
	return status
}

func cappedCombinedOutput(cmd *exec.Cmd, limit int) (string, error) {
	var output limitedBuffer
	output.limit = limit
	cmd.Stdout = &output
	cmd.Stderr = &output
	err := cmd.Run()
	return output.String(), err
}

type limitedBuffer struct {
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	originalLength := len(data)
	remaining := b.limit - b.buf.Len()
	if remaining <= 0 {
		b.truncated = true
		return originalLength, nil
	}
	if len(data) > remaining {
		data = data[:remaining]
		b.truncated = true
	}
	_, _ = b.buf.Write(data)
	return originalLength, nil
}

func (b *limitedBuffer) String() string {
	if b.truncated {
		return b.buf.String() + "\n[output truncated]"
	}
	return b.buf.String()
}

type journalEntry struct {
	Cursor            string          `json:"__CURSOR"`
	RealtimeTimestamp string          `json:"__REALTIME_TIMESTAMP"`
	Priority          string          `json:"PRIORITY"`
	Message           json.RawMessage `json:"MESSAGE"`
}

func streamJournal(ctx context.Context, unit string, currentCursor func() string, send func(any) error, persistCursor func(string) error) {
	if !validUnitName(unit) {
		return
	}
	backoff := time.Second
	cursorInvalid := false
	for ctx.Err() == nil {
		cursor := currentCursor()
		useCursor := cursor != "" && !cursorInvalid
		cmd := exec.CommandContext(ctx, "journalctl", journalctlArgs(unit, cursor, cursorInvalid)...)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			if !waitContext(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff, 15*time.Second)
			continue
		}
		stderr := &limitedBuffer{limit: 16 * 1024}
		cmd.Stderr = stderr
		if err := cmd.Start(); err != nil {
			if !waitContext(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff, 15*time.Second)
			continue
		}

		started := time.Now()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			line, ok := parseJournalEntry(scanner.Bytes())
			if !ok {
				continue
			}
			if deliverJournalLine(logMessage{Type: "log", Line: line}, send, persistCursor) != nil {
				break
			}
			if line.Cursor != "" {
				cursorInvalid = false
			}
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if useCursor && journalCursorInvalid(stderr.String()) {
			cursorInvalid = true
			backoff = time.Second
			continue
		}
		if time.Since(started) > 30*time.Second {
			backoff = time.Second
		}
		if !waitContext(ctx, backoff) {
			return
		}
		backoff = nextBackoff(backoff, 15*time.Second)
	}
}

func journalctlArgs(unit, cursor string, cursorInvalid bool) []string {
	args := []string{"--follow", "--output=json", "--no-pager", "--unit", unit}
	if cursor != "" && !cursorInvalid {
		return append(args, "--after-cursor", cursor)
	}
	return append(args, fmt.Sprintf("--lines=%d", journalTailLines), "--since=-5min")
}

func journalCursorInvalid(stderr string) bool {
	message := strings.ToLower(stderr)
	if !strings.Contains(message, "cursor") {
		return false
	}
	return strings.Contains(message, "invalid") ||
		strings.Contains(message, "failed") ||
		strings.Contains(message, "not found") ||
		strings.Contains(message, "cannot")
}

func deliverJournalLine(message logMessage, send func(any) error, persistCursor func(string) error) error {
	if err := send(message); err != nil {
		return err
	}
	if message.Line.Cursor == "" {
		return nil
	}
	return persistCursor(message.Line.Cursor)
}

func parseJournalEntry(data []byte) (logLine, bool) {
	var entry journalEntry
	if json.Unmarshal(data, &entry) != nil {
		return logLine{}, false
	}
	var message string
	if json.Unmarshal(entry.Message, &message) != nil {
		message = string(entry.Message)
	}
	createdAt := timestamp()
	if micros, err := strconv.ParseInt(entry.RealtimeTimestamp, 10, 64); err == nil {
		createdAt = time.UnixMicro(micros).UTC().Format(time.RFC3339Nano)
	}
	return logLine{Cursor: entry.Cursor, CreatedAt: createdAt, Stream: priorityStream(entry.Priority), Message: message}, true
}

func priorityStream(priority string) string {
	value, err := strconv.Atoi(priority)
	if err == nil && value <= 3 {
		return "stderr"
	}
	return "stdout"
}

func nextBackoff(current, maximum time.Duration) time.Duration {
	next := current * 2
	if next > maximum {
		return maximum
	}
	return next
}

func waitContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
