package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

const (
	rconResponseValue = 0
	rconCommand       = 2
	rconAuth          = 3
	maxRCONPacket     = 4 << 20
	rconQuietTimeout  = 200 * time.Millisecond
)

type rconPacket struct {
	ID      int32
	Type    int32
	Payload string
}

func encodeRCONPacket(packet rconPacket) ([]byte, error) {
	if strings.IndexByte(packet.Payload, 0) >= 0 {
		return nil, errors.New("RCON payload contains NUL")
	}
	length := 4 + 4 + len(packet.Payload) + 2
	if length > maxRCONPacket {
		return nil, errors.New("RCON packet is too large")
	}
	buf := make([]byte, length+4)
	binary.LittleEndian.PutUint32(buf[0:4], uint32(length))
	binary.LittleEndian.PutUint32(buf[4:8], uint32(packet.ID))
	binary.LittleEndian.PutUint32(buf[8:12], uint32(packet.Type))
	copy(buf[12:], packet.Payload)
	return buf, nil
}

func decodeRCONPacket(reader io.Reader) (rconPacket, error) {
	var length int32
	if err := binary.Read(reader, binary.LittleEndian, &length); err != nil {
		return rconPacket{}, err
	}
	if length < 10 || length > maxRCONPacket {
		return rconPacket{}, fmt.Errorf("invalid RCON packet length %d", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(reader, body); err != nil {
		return rconPacket{}, err
	}
	if body[len(body)-2] != 0 || body[len(body)-1] != 0 {
		return rconPacket{}, errors.New("invalid RCON packet terminator")
	}
	return rconPacket{
		ID:      int32(binary.LittleEndian.Uint32(body[0:4])),
		Type:    int32(binary.LittleEndian.Uint32(body[4:8])),
		Payload: string(body[8 : len(body)-2]),
	}, nil
}

func executeRCON(ctx context.Context, cfg RCONConfig, command string, outputLimit int) (string, error) {
	dialer := net.Dialer{Timeout: cfg.timeout()}
	conn, err := dialer.DialContext(ctx, "tcp", cfg.Address)
	if err != nil {
		return "", fmt.Errorf("connect RCON: %w", err)
	}
	defer conn.Close()

	deadline := time.Now().Add(cfg.timeout())
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return "", err
	}

	reader := bufio.NewReader(conn)
	if err := writeRCONPacket(conn, rconPacket{ID: 1, Type: rconAuth, Payload: cfg.Password}); err != nil {
		return "", fmt.Errorf("send RCON authentication: %w", err)
	}
	authenticated := false
	for range 2 {
		auth, err := decodeRCONPacket(reader)
		if err != nil {
			return "", fmt.Errorf("read RCON authentication: %w", err)
		}
		if auth.ID == -1 {
			return "", errors.New("RCON authentication failed")
		}
		if auth.ID == 1 && auth.Type == rconCommand {
			authenticated = true
			break
		}
	}
	if !authenticated {
		return "", errors.New("invalid RCON authentication response")
	}

	if err := writeRCONPacket(conn, rconPacket{ID: 2, Type: rconCommand, Payload: command}); err != nil {
		return "", fmt.Errorf("send RCON command: %w", err)
	}

	var output strings.Builder
	truncated := false
	received := false
	for {
		packet, err := decodeRCONPacket(reader)
		if err != nil {
			if received && (isNetworkTimeout(err) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)) {
				break
			}
			return "", fmt.Errorf("read RCON response: %w", err)
		}
		if packet.ID != 2 || packet.Type != rconResponseValue {
			continue
		}
		received = true
		remaining := outputLimit - output.Len()
		if remaining <= 0 {
			truncated = true
			continue
		}
		if len(packet.Payload) > remaining {
			output.WriteString(packet.Payload[:remaining])
			truncated = true
		} else {
			output.WriteString(packet.Payload)
		}
		quietDeadline := time.Now().Add(rconQuietTimeout)
		if quietDeadline.After(deadline) {
			quietDeadline = deadline
		}
		if err := conn.SetReadDeadline(quietDeadline); err != nil {
			return "", fmt.Errorf("set RCON quiet deadline: %w", err)
		}
	}
	if truncated {
		output.WriteString("\n[output truncated]")
	}
	return output.String(), nil
}

func isNetworkTimeout(err error) bool {
	var networkError net.Error
	return errors.As(err, &networkError) && networkError.Timeout()
}

func writeRCONPacket(writer io.Writer, packet rconPacket) error {
	data, err := encodeRCONPacket(packet)
	if err != nil {
		return err
	}
	for len(data) > 0 {
		written, err := writer.Write(data)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}
