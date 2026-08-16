package main

import "time"

const agentVersion = "0.2.0"

type inboundMessage struct {
	Type    string          `json:"type"`
	Command commandEnvelope `json:"command"`
	Cursor  string          `json:"cursor"`
	Request filesystemRequest `json:"request"`
}

type filesystemRequest struct {
	ID              string   `json:"id"`
	BindingID       string   `json:"bindingId"`
	Operation       string   `json:"operation"`
	Path            string   `json:"path,omitempty"`
	SourcePath      string   `json:"sourcePath,omitempty"`
	DestinationPath string   `json:"destinationPath,omitempty"`
	Paths           []string `json:"paths,omitempty"`
	Data            string   `json:"data,omitempty"`
	MaxBytes       int64    `json:"maxBytes,omitempty"`
	Overwrite       bool     `json:"overwrite,omitempty"`
	Confirm         bool     `json:"confirm,omitempty"`
}

type filesystemResponse struct {
	Type      string            `json:"type"`
	RequestID string            `json:"requestId"`
	OK        bool              `json:"ok"`
	Result    any               `json:"result,omitempty"`
	Error     *filesystemError  `json:"error,omitempty"`
}

type filesystemError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
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
