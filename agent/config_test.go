package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validTestConfig() Config {
	return Config{
		PanelURL: "https://panel.example.com",
		Bindings: []BindingConfig{{
			ID:    "binding-1",
			Token: "secret",
			Unit:  "gravit-server-12345678-1234-1234-1234-123456789abc.service",
			RCON: RCONConfig{
				Address:  "127.0.0.1:25575",
				Password: "rcon-secret",
			},
		}},
	}
}

func TestConfigValidate(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
		want   string
	}{
		{name: "valid"},
		{name: "legacy unit", mutate: func(c *Config) { c.Bindings[0].Unit = "gravit-deadbeef.service" }},
		{name: "bad panel scheme", mutate: func(c *Config) { c.PanelURL = "file:///tmp/panel" }, want: "panelUrl"},
		{name: "no binding source", mutate: func(c *Config) { c.Bindings = nil }, want: "exactly one"},
		{name: "empty inline bindings", mutate: func(c *Config) { c.Bindings = []BindingConfig{} }, want: "at least one binding"},
		{name: "both binding sources", mutate: func(c *Config) { c.BindingsDir = "bindings.d" }, want: "exactly one"},
		{name: "duplicate binding", mutate: func(c *Config) { c.Bindings = append(c.Bindings, c.Bindings[0]) }, want: "duplicated"},
		{name: "unsafe unit", mutate: func(c *Config) { c.Bindings[0].Unit = "gravit-server-x.service; reboot" }, want: "unit"},
		{name: "missing token", mutate: func(c *Config) { c.Bindings[0].Token = "" }, want: "token"},
		{name: "missing RCON address", mutate: func(c *Config) { c.Bindings[0].RCON.Address = "" }, want: "rcon.address"},
		{name: "negative timeout", mutate: func(c *Config) { c.Bindings[0].RCON.TimeoutSeconds = -1 }, want: "timeoutSeconds"},
		{name: "blank state directory", mutate: func(c *Config) { c.StateDir = "   " }, want: "stateDir"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := validTestConfig()
			if test.mutate != nil {
				test.mutate(&cfg)
			}
			err := cfg.validate()
			if test.want == "" && err != nil {
				t.Fatalf("validate() error = %v", err)
			}
			if test.want != "" && (err == nil || !strings.Contains(err.Error(), test.want)) {
				t.Fatalf("validate() error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestWebsocketURL(t *testing.T) {
	cfg := validTestConfig()
	cfg.PanelURL = "https://panel.example.com/base/?discard=true#fragment"
	got, err := cfg.websocketURL()
	if err != nil {
		t.Fatal(err)
	}
	want := "wss://panel.example.com/base/api/server-agent/connect"
	if got != want {
		t.Fatalf("websocketURL() = %q, want %q", got, want)
	}
}

func TestLoadConfigRejectsOpenPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	data := `{"panelUrl":"https://panel.example.com","bindings":[]}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), "0600") {
		t.Fatalf("loadConfig() error = %v, want permissions error", err)
	}
}

func TestLoadConfigFromBindingsDirectory(t *testing.T) {
	root := t.TempDir()
	bindingsDir := filepath.Join(root, "bindings.d")
	if err := os.Mkdir(bindingsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeBindingFragment(t, filepath.Join(bindingsDir, "20-second.json"), testBinding("binding-2", "gravit-feedface.service"), 0o600)
	writeBindingFragment(t, filepath.Join(bindingsDir, "10-first.json"), testBinding("binding-1", "gravit-deadbeef.service"), 0o600)
	if err := os.WriteFile(filepath.Join(bindingsDir, "ignored.txt"), []byte("ignored"), 0o644); err != nil {
		t.Fatal(err)
	}
	hostConfig := filepath.Join(root, "config.json")
	writeHostConfig(t, hostConfig, "bindings.d")

	cfg, err := loadConfig(hostConfig)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Bindings) != 2 {
		t.Fatalf("loaded %d bindings, want 2", len(cfg.Bindings))
	}
	if cfg.Bindings[0].ID != "binding-1" || cfg.Bindings[1].ID != "binding-2" {
		t.Fatalf("binding order = %q, %q; want filename order", cfg.Bindings[0].ID, cfg.Bindings[1].ID)
	}
}

func TestLoadConfigRejectsDuplicateFragmentIDs(t *testing.T) {
	root := t.TempDir()
	bindingsDir := filepath.Join(root, "bindings.d")
	if err := os.Mkdir(bindingsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeBindingFragment(t, filepath.Join(bindingsDir, "one.json"), testBinding("duplicate", "gravit-deadbeef.service"), 0o600)
	writeBindingFragment(t, filepath.Join(bindingsDir, "two.json"), testBinding("duplicate", "gravit-feedface.service"), 0o600)
	hostConfig := filepath.Join(root, "config.json")
	writeHostConfig(t, hostConfig, "bindings.d")

	_, err := loadConfig(hostConfig)
	if err == nil || !strings.Contains(err.Error(), "duplicated") {
		t.Fatalf("loadConfig() error = %v, want duplicate ID error", err)
	}
}

func TestBindingFragmentSecurity(t *testing.T) {
	tests := []struct {
		name  string
		setup func(*testing.T, string)
		want  string
	}{
		{
			name: "open permissions",
			setup: func(t *testing.T, directory string) {
				writeBindingFragment(t, filepath.Join(directory, "binding.json"), testBinding("binding-1", "gravit-deadbeef.service"), 0o644)
			},
			want: "0600",
		},
		{
			name: "symlink",
			setup: func(t *testing.T, directory string) {
				target := filepath.Join(t.TempDir(), "target.json")
				writeBindingFragment(t, target, testBinding("binding-1", "gravit-deadbeef.service"), 0o600)
				if err := os.Symlink(target, filepath.Join(directory, "binding.json")); err != nil {
					t.Fatal(err)
				}
			},
			want: "symlink",
		},
		{
			name: "non-regular",
			setup: func(t *testing.T, directory string) {
				if err := os.Mkdir(filepath.Join(directory, "binding.json"), 0o700); err != nil {
					t.Fatal(err)
				}
			},
			want: "regular file",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "bindings.d")
			if err := os.Mkdir(directory, 0o700); err != nil {
				t.Fatal(err)
			}
			test.setup(t, directory)
			_, err := loadBindingFragments(directory)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("loadBindingFragments() error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestLoadBindingFragmentsRejectsInsecureDirectory(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "bindings.d")
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := loadBindingFragments(directory)
	if err == nil || !strings.Contains(err.Error(), "too open") {
		t.Fatalf("loadBindingFragments() error = %v, want directory permissions error", err)
	}
}

func TestLoadBindingFragmentsRejectsDirectorySymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "real-bindings")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "bindings.d")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	_, err := loadBindingFragments(link)
	if err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("loadBindingFragments() error = %v, want directory symlink error", err)
	}
}

func testBinding(id, unit string) BindingConfig {
	return BindingConfig{
		ID: id, Token: "secret", Unit: unit,
		RCON: RCONConfig{Address: "127.0.0.1:25575", Password: "rcon-secret"},
	}
}

func writeBindingFragment(t *testing.T, path string, binding BindingConfig, mode os.FileMode) {
	t.Helper()
	data, err := json.Marshal(binding)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
}

func writeHostConfig(t *testing.T, path, bindingsDir string) {
	t.Helper()
	data := fmt.Sprintf(`{"panelUrl":"https://panel.example.com","bindingsDir":%q}`, bindingsDir)
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestValidUnitName(t *testing.T) {
	valid := []string{
		"gravit-server-12345678-1234-1234-1234-123456789abc.service",
		"gravit-deadbeef.service",
		"gravit-main.service",
		"gravit-glavniy.service",
	}
	invalid := []string{
		"minecraft.service",
		"gravit-DEADBEEF.service",
		"gravit-deadbeef.service --now",
		"gravit--main.service",
		"gravit-main-.service",
		"gravit-.service",
	}
	for _, unit := range valid {
		if !validUnitName(unit) {
			t.Errorf("validUnitName(%q) = false", unit)
		}
	}
	for _, unit := range invalid {
		if validUnitName(unit) {
			t.Errorf("validUnitName(%q) = true", unit)
		}
	}
}
