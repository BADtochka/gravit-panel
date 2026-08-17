package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const commandQueueCapacity = 64

type bindingAgent struct {
	config            BindingConfig
	endpoint          string
	heartbeatInterval time.Duration
	hostname          string
	logger            *slog.Logger
	commands          chan queuedCommand
	results           *commandResultCache
	filesystemRoot    string
}

type queuedCommand struct {
	session *connectionSession
	command commandEnvelope
}

type connectionSession struct {
	conn   *websocket.Conn
	write  sync.Mutex
	cancel context.CancelFunc
	ackMu  sync.Mutex
	logAcks map[string]chan struct{}
}

func (a *bindingAgent) run(ctx context.Context) {
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		a.commandWorker(ctx)
	}()
	defer func() { <-workerDone }()

	backoff := time.Second
	for ctx.Err() == nil {
		connectedAt := time.Now()
		err := a.connect(ctx)
		if ctx.Err() != nil {
			return
		}
		a.logger.Warn("connection ended", "error", err, "retryIn", backoff)
		if time.Since(connectedAt) > time.Minute {
			backoff = time.Second
		}
		jitter := time.Duration(rand.Int63n(int64(backoff/4 + 1)))
		if !waitContext(ctx, backoff+jitter) {
			return
		}
		backoff = nextBackoff(backoff, 30*time.Second)
	}
}

func (a *bindingAgent) connect(parent context.Context) error {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, Proxy: http.ProxyFromEnvironment}
	conn, response, err := dialer.DialContext(parent, a.endpoint, nil)
	if err != nil {
		if response != nil {
			return fmt.Errorf("websocket handshake returned %s: %w", response.Status, err)
		}
		return fmt.Errorf("websocket connect: %w", err)
	}
	ctx, cancel := context.WithCancel(parent)
	session := &connectionSession{conn: conn, cancel: cancel, logAcks: make(map[string]chan struct{})}
	readStopped := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-readStopped:
		}
	}()
	defer func() {
		close(readStopped)
		cancel()
		_ = session.close()
	}()
	conn.SetReadLimit(384 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(2 * a.heartbeatInterval))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(2 * a.heartbeatInterval))
	})

	if err := session.send(helloMessage{
		Type:         "hello",
		Token:        a.config.Token,
		AgentVersion: agentVersion,
		Hostname:     a.hostname,
		Capabilities: a.capabilities(),
	}); err != nil {
		return err
	}
	if err := session.send(statusMessage{Type: "status", Runtime: queryStatus(ctx, a.config.Unit)}); err != nil {
		return err
	}

	go a.periodicUpdates(ctx, session)
	go streamJournal(ctx, a.config.Unit, a.results.journalCursor, func(message any) error {
		line, ok := message.(logMessage)
		if !ok {
			return errors.New("invalid journal message")
		}
		err := session.sendLog(ctx, line)
		if err != nil {
			cancel()
		}
		return err
	}, func(cursor string) error {
		err := a.results.saveJournalCursor(cursor)
		if err != nil {
			a.logger.Error("persist journal cursor", "error", err)
		}
		return err
	})

	for {
		var message inboundMessage
		if err := conn.ReadJSON(&message); err != nil {
			return err
		}
		if message.Type == "log.ack" {
			session.ackLog(message.Cursor)
			continue
		}
		if message.Type == "fs.request" {
			response := a.handleFilesystem(message.Request)
			if err := session.send(response); err != nil {
				return err
			}
			continue
		}
		if message.Type != "command" {
			continue
		}
		if message.Command.ID == "" {
			a.logger.Warn("ignored command without id")
			continue
		}
		if err := session.send(commandResultMessage{Type: "command.ack", CommandID: message.Command.ID}); err != nil {
			return err
		}
		cached, pending, owner, err := a.results.begin(message.Command.ID)
		if err != nil {
			result := commandResultMessage{Type: "command.failed", CommandID: message.Command.ID, Error: err.Error()}
			if sendErr := session.send(result); sendErr != nil {
				return sendErr
			}
			continue
		}
		if cached != nil {
			if err := session.send(*cached); err != nil {
				return err
			}
			continue
		}
		if !owner {
			go a.replayPending(ctx, session, pending)
			continue
		}
		if !a.enqueueCommand(queuedCommand{session: session, command: message.Command}) {
			result := commandResultMessage{Type: "command.failed", CommandID: message.Command.ID, Error: "command queue is full for this binding"}
			if err := a.results.complete(message.Command.ID, result); err != nil {
				a.logger.Error("persist command result", "commandId", message.Command.ID, "error", err)
			}
			if err := session.send(result); err != nil {
				return err
			}
		}
	}
}

func (a *bindingAgent) capabilities() []string {
	capabilities := []string{"systemd", "journald", "rcon"}
	if a.filesystemRoot != "" {
		capabilities = append(capabilities, "filesystem-v1")
	}
	return capabilities
}

func (a *bindingAgent) enqueueCommand(command queuedCommand) bool {
	select {
	case a.commands <- command:
		return true
	default:
		return false
	}
}

func (a *bindingAgent) commandWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case command := <-a.commands:
			a.executeCommand(ctx, command.session, command.command)
		}
	}
}

func (a *bindingAgent) replayPending(ctx context.Context, session *connectionSession, pending *pendingCommandResult) {
	result, ok := pending.wait(ctx)
	if !ok {
		return
	}
	if err := session.send(result); err != nil {
		session.cancel()
	}
}

func (a *bindingAgent) periodicUpdates(ctx context.Context, session *connectionSession) {
	ticker := time.NewTicker(a.heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := session.ping(); err != nil {
				session.cancel()
				return
			}
			if session.send(heartbeatMessage{Type: "heartbeat", CreatedAt: timestamp()}) != nil {
				session.cancel()
				return
			}
			if session.send(statusMessage{Type: "status", Runtime: queryStatus(ctx, a.config.Unit)}) != nil {
				session.cancel()
				return
			}
		}
	}
}

func (a *bindingAgent) executeCommand(ctx context.Context, session *connectionSession, command commandEnvelope) {
	var output string
	var err error

	if command.BindingID != "" && command.BindingID != a.config.ID {
		err = errors.New("command bindingId does not match this binding")
	} else {
		switch command.Type {
		case "service.start":
			output, err = runSystemctl(ctx, "start", a.config.Unit)
		case "service.stop":
			output, err = runSystemctl(ctx, "stop", a.config.Unit)
		case "service.restart":
			output, err = runSystemctl(ctx, "restart", a.config.Unit)
		case "console.execute":
			if command.Payload.Command == "" {
				err = errors.New("payload.command is required")
			} else if len(command.Payload.Command) > maxCommandBytes {
				err = fmt.Errorf("command exceeds %d bytes", maxCommandBytes)
			} else if strings.IndexByte(command.Payload.Command, 0) >= 0 {
				err = errors.New("command contains NUL")
			} else {
				commandCtx, cancel := context.WithTimeout(ctx, a.config.RCON.timeout())
				output, err = executeRCON(commandCtx, a.config.RCON, command.Payload.Command, maxOutputBytes)
				cancel()
			}
		default:
			err = fmt.Errorf("unsupported command type %q", command.Type)
		}
	}

	result := commandResultMessage{Type: "command.completed", CommandID: command.ID, Output: output}
	if err != nil {
		result.Type = "command.failed"
		result.Error = err.Error()
		result.Output = ""
	}
	if persistErr := a.results.complete(command.ID, result); persistErr != nil {
		a.logger.Error("persist command result", "commandId", command.ID, "error", persistErr)
	}
	if sendErr := session.send(result); sendErr != nil {
		session.cancel()
		return
	}
	if strings.HasPrefix(command.Type, "service.") {
		if sendErr := session.send(statusMessage{Type: "status", Runtime: queryStatus(ctx, a.config.Unit)}); sendErr != nil {
			session.cancel()
		}
	}
}

func (s *connectionSession) send(message any) error {
	s.write.Lock()
	defer s.write.Unlock()
	if err := s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	return s.conn.WriteJSON(message)
}

func (s *connectionSession) ping() error {
	s.write.Lock()
	defer s.write.Unlock()
	return s.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second))
}

func (s *connectionSession) sendLog(ctx context.Context, message logMessage) error {
	if message.Line.Cursor == "" {
		return s.send(message)
	}
	ack := make(chan struct{})
	s.ackMu.Lock()
	s.logAcks[message.Line.Cursor] = ack
	s.ackMu.Unlock()
	defer func() {
		s.ackMu.Lock()
		delete(s.logAcks, message.Line.Cursor)
		s.ackMu.Unlock()
	}()
	if err := s.send(message); err != nil {
		return err
	}
	select {
	case <-ack:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(10 * time.Second):
		return errors.New("journal acknowledgement timed out")
	}
}

func (s *connectionSession) ackLog(cursor string) {
	s.ackMu.Lock()
	ack := s.logAcks[cursor]
	s.ackMu.Unlock()
	if ack != nil {
		select {
		case <-ack:
		default:
			close(ack)
		}
	}
}

func (s *connectionSession) close() error {
	s.write.Lock()
	defer s.write.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_ = s.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "agent shutting down"))
	return s.conn.Close()
}

func newBindingAgents(cfg Config, logger *slog.Logger) ([]*bindingAgent, error) {
	endpoint, err := cfg.websocketURL()
	if err != nil {
		return nil, err
	}
	hostname, err := os.Hostname()
	if err != nil {
		return nil, fmt.Errorf("get hostname: %w", err)
	}
	agents := make([]*bindingAgent, 0, len(cfg.Bindings))
	for _, binding := range cfg.Bindings {
		results, err := openCommandResultCache(cfg.stateDirectory(), binding.ID, maxCachedCommandResults)
		if err != nil {
			return nil, fmt.Errorf("initialize command state for binding %q: %w", binding.ID, err)
		}
		filesystemRoot, rootErr := initializeFilesystemRoot(binding)
		if rootErr != nil && binding.Root != "" {
			logger.Warn("live filesystem unavailable", "bindingId", binding.ID, "error", rootErr)
		}
		agents = append(agents, &bindingAgent{
			config:            binding,
			endpoint:          endpoint,
			heartbeatInterval: cfg.heartbeatInterval(),
			hostname:          hostname,
			logger:            logger.With("bindingId", binding.ID, "unit", binding.Unit),
			commands:          make(chan queuedCommand, commandQueueCapacity),
			results:           results,
			filesystemRoot:    filesystemRoot,
		})
	}
	return agents, nil
}
