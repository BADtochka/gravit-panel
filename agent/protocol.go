package main

import "time"

const agentVersion = "0.2.0"

type inboundMessage struct {
	Type    string          `json:"type"`
	Command commandEnvelope `json:"command"`
}

type commandEnvelope struct {
	ID        string         `json:"id"`
	BindingID string         `json:"bindingId"`
	Type      string         `json:"type"`
	Payload   commandPayload `json:"payload"`
	CreatedAt string         `json:"createdAt"`
}

type commandPayload struct {
	Command string `json:"command,omitempty"`
}

type helloMessage struct {
	Type         string   `json:"type"`
	Token        string   `json:"token"`
	AgentVersion string   `json:"agentVersion"`
	Hostname     string   `json:"hostname"`
	Capabilities []string `json:"capabilities"`
}

type commandResultMessage struct {
	Type      string `json:"type"`
	CommandID string `json:"commandId"`
	Output    string `json:"output,omitempty"`
	Error     string `json:"error,omitempty"`
}

type heartbeatMessage struct {
	Type      string `json:"type"`
	CreatedAt string `json:"createdAt"`
}

type statusMessage struct {
	Type    string        `json:"type"`
	Runtime runtimeStatus `json:"runtime"`
}

type runtimeStatus struct {
	State     string `json:"state"`
	SubState  string `json:"subState"`
	MainPID   int    `json:"mainPid"`
	UpdatedAt string `json:"updatedAt"`
}

type logMessage struct {
	Type string  `json:"type"`
	Line logLine `json:"line"`
}

type logLine struct {
	Cursor    string `json:"cursor"`
	CreatedAt string `json:"createdAt"`
	Stream    string `json:"stream"`
	Message   string `json:"message"`
}

func timestamp() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
