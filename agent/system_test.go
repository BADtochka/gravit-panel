package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestRunPackUpdaterRejectsInvalidServerUnit(t *testing.T) {
	_, err := runPackUpdater(context.Background(), "../../evil.service")
	if err == nil {
		t.Fatal("runPackUpdater() accepted an invalid server unit")
	}
}

func TestPackUpdaterUnitIsDerivedFromValidatedServerUnit(t *testing.T) {
	unit, err := packUpdaterUnit("gravit-deadbeef.service")
	if err != nil {
		t.Fatal(err)
	}
	if unit != "gravit-deadbeef-pack-update.service" {
		t.Fatalf("packUpdaterUnit() = %q", unit)
	}
}

func TestDeliverJournalLinePersistsOnlyAfterSuccessfulSend(t *testing.T) {
	message := logMessage{Type: "log", Line: logLine{Cursor: "cursor-1", Message: "hello"}}
	var calls []string
	err := deliverJournalLine(message, func(any) error {
		calls = append(calls, "send")
		return nil
	}, func(cursor string) error {
		calls = append(calls, "persist:"+cursor)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"send", "persist:cursor-1"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v, want %#v", calls, want)
	}
}

func TestDeliverJournalLineDoesNotPersistAfterSendFailure(t *testing.T) {
	persisted := false
	err := deliverJournalLine(logMessage{Line: logLine{Cursor: "cursor-1"}}, func(any) error {
		return errors.New("send failed")
	}, func(string) error {
		persisted = true
		return nil
	})
	if err == nil {
		t.Fatal("deliverJournalLine() returned nil after send failure")
	}
	if persisted {
		t.Fatal("cursor was persisted before a successful send")
	}
}

func TestJournalctlArgsUseCursorOrBoundedFallback(t *testing.T) {
	withCursor := journalctlArgs("gravit-deadbeef.service", "cursor-1", false)
	if !containsArgumentPair(withCursor, "--after-cursor", "cursor-1") {
		t.Fatalf("cursor arguments = %#v", withCursor)
	}
	fallback := journalctlArgs("gravit-deadbeef.service", "cursor-1", true)
	if !containsArgument(fallback, "--lines=200") || !containsArgument(fallback, "--since=-5min") {
		t.Fatalf("fallback arguments are not bounded: %#v", fallback)
	}
	if containsArgument(fallback, "--after-cursor") {
		t.Fatalf("fallback unexpectedly uses invalid cursor: %#v", fallback)
	}
}

func TestJournalCursorInvalid(t *testing.T) {
	if !journalCursorInvalid("Failed to seek to cursor: Invalid argument") {
		t.Fatal("invalid journal cursor error was not recognized")
	}
	if journalCursorInvalid("Failed to open journal: Permission denied") {
		t.Fatal("unrelated journal error was classified as an invalid cursor")
	}
}

func containsArgument(arguments []string, want string) bool {
	for _, argument := range arguments {
		if argument == want {
			return true
		}
	}
	return false
}

func containsArgumentPair(arguments []string, first, second string) bool {
	for i := 0; i+1 < len(arguments); i++ {
		if arguments[i] == first && arguments[i+1] == second {
			return true
		}
	}
	return false
}
