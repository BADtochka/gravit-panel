package main

import (
	"context"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestRCONPacketRoundTrip(t *testing.T) {
	want := rconPacket{ID: 42, Type: rconCommand, Payload: "say hello"}
	encoded, err := encodeRCONPacket(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeRCONPacket(strings.NewReader(string(encoded)))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded packet = %#v, want %#v", got, want)
	}
}

func TestRCONPacketOverNetPipe(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	want := rconPacket{ID: -7, Type: rconResponseValue, Payload: "response"}

	errCh := make(chan error, 1)
	go func() { errCh <- writeRCONPacket(client, want) }()
	got, err := decodeRCONPacket(server)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded packet = %#v, want %#v", got, want)
	}
}

func TestExecuteRCON(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	serverErr := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()
		auth, err := decodeRCONPacket(conn)
		if err != nil {
			serverErr <- err
			return
		}
		if auth.Type != rconAuth || auth.Payload != "password" {
			serverErr <- &packetTestError{"unexpected authentication packet"}
			return
		}
		if err := writeRCONPacket(conn, rconPacket{ID: auth.ID, Type: rconResponseValue}); err != nil {
			serverErr <- err
			return
		}
		if err := writeRCONPacket(conn, rconPacket{ID: auth.ID, Type: rconCommand}); err != nil {
			serverErr <- err
			return
		}
		command, err := decodeRCONPacket(conn)
		if err != nil {
			serverErr <- err
			return
		}
		if command.Payload != "list" || command.Type != rconCommand {
			serverErr <- &packetTestError{"unexpected command packet"}
			return
		}
		if err := conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond)); err != nil {
			serverErr <- err
			return
		}
		if _, err := decodeRCONPacket(conn); !isNetworkTimeout(err) {
			serverErr <- &packetTestError{"client sent a nonstandard marker packet"}
			return
		}
		if err := conn.SetReadDeadline(time.Time{}); err != nil {
			serverErr <- err
			return
		}
		if err := writeRCONPacket(conn, rconPacket{ID: command.ID, Type: rconResponseValue, Payload: "players: "}); err != nil {
			serverErr <- err
			return
		}
		time.Sleep(25 * time.Millisecond)
		if err := writeRCONPacket(conn, rconPacket{ID: command.ID, Type: rconResponseValue, Payload: "1"}); err != nil {
			serverErr <- err
			return
		}
		time.Sleep(rconQuietTimeout + 50*time.Millisecond)
		serverErr <- nil
	}()

	cfg := RCONConfig{Address: listener.Addr().String(), Password: "password", TimeoutSeconds: 2}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	got, err := executeRCON(ctx, cfg, "list", 1024)
	if err != nil {
		t.Fatal(err)
	}
	if got != "players: 1" {
		t.Fatalf("executeRCON() = %q, want %q", got, "players: 1")
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
}

type packetTestError struct{ message string }

func (e *packetTestError) Error() string { return e.message }

func TestDecodeRCONPacketRejectsInvalidLength(t *testing.T) {
	_, err := decodeRCONPacket(strings.NewReader("\x09\x00\x00\x00"))
	if err == nil {
		t.Fatal("decodeRCONPacket() accepted undersized packet")
	}
}
