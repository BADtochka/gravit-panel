package main

import "testing"

func TestBindingCommandQueueIsFIFOAndBounded(t *testing.T) {
	agent := &bindingAgent{commands: make(chan queuedCommand, 2)}
	first := queuedCommand{command: commandEnvelope{ID: "first"}}
	second := queuedCommand{command: commandEnvelope{ID: "second"}}
	third := queuedCommand{command: commandEnvelope{ID: "third"}}

	if !agent.enqueueCommand(first) || !agent.enqueueCommand(second) {
		t.Fatal("back-to-back commands were not both queued")
	}
	if agent.enqueueCommand(third) {
		t.Fatal("queue accepted a command beyond its bounded capacity")
	}
	if got := (<-agent.commands).command.ID; got != "first" {
		t.Fatalf("first dequeued command = %q, want first", got)
	}
	if got := (<-agent.commands).command.ID; got != "second" {
		t.Fatalf("second dequeued command = %q, want second", got)
	}
}
