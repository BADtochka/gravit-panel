package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

var (
	serverUnitPattern = regexp.MustCompile(`^gravit-server-[0-9a-f-]{36}\.service$`)
	legacyUnitPattern = regexp.MustCompile(`^gravit-[0-9a-f]{8}\.service$`)
)

type Config struct {
	PanelURL             string          `json:"panelUrl"`
	HeartbeatIntervalSec int             `json:"heartbeatIntervalSeconds,omitempty"`
	Bindings             []BindingConfig `json:"bindings,omitempty"`
	BindingsDir          string          `json:"bindingsDir,omitempty"`
	StateDir             string          `json:"stateDir,omitempty"`
}

type BindingConfig struct {
	ID    string     `json:"id"`
	Token string     `json:"token"`
	Unit  string     `json:"unit"`
	RCON  RCONConfig `json:"rcon"`
}

type RCONConfig struct {
	Address        string `json:"address"`
	Password       string `json:"password"`
	TimeoutSeconds int    `json:"timeoutSeconds,omitempty"`
}

func loadConfig(path string) (Config, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Config{}, fmt.Errorf("stat config: %w", err)
	}
	if !info.Mode().IsRegular() {
		return Config{}, errors.New("config must be a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return Config{}, fmt.Errorf("config permissions %04o are too open; use 0600", info.Mode().Perm())
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := decodeStrictJSON(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("decode config: %w", err)
	}
	if err := cfg.validateSources(); err != nil {
		return Config{}, err
	}
	if cfg.BindingsDir != "" {
		bindingsDir := cfg.BindingsDir
		if !filepath.IsAbs(bindingsDir) {
			bindingsDir = filepath.Join(filepath.Dir(path), bindingsDir)
		}
		bindings, err := loadBindingFragments(bindingsDir)
		if err != nil {
			return Config{}, err
		}
		cfg.Bindings = bindings
		cfg.BindingsDir = ""
	}
	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) validate() error {
	if err := c.validateSources(); err != nil {
		return err
	}
	if _, err := c.websocketURL(); err != nil {
		return err
	}
	if c.HeartbeatIntervalSec < 0 {
		return errors.New("heartbeatIntervalSeconds cannot be negative")
	}
	if c.StateDir != "" && strings.TrimSpace(c.StateDir) == "" {
		return errors.New("stateDir cannot be blank")
	}
	if c.Bindings == nil || len(c.Bindings) == 0 {
		return errors.New("at least one binding is required")
	}

	ids := make(map[string]struct{}, len(c.Bindings))
	for i, binding := range c.Bindings {
		prefix := fmt.Sprintf("bindings[%d]", i)
		if strings.TrimSpace(binding.ID) == "" {
			return fmt.Errorf("%s.id is required", prefix)
		}
		if _, exists := ids[binding.ID]; exists {
			return fmt.Errorf("%s.id %q is duplicated", prefix, binding.ID)
		}
		ids[binding.ID] = struct{}{}
		if strings.TrimSpace(binding.Token) == "" {
			return fmt.Errorf("%s.token is required", prefix)
		}
		if !validUnitName(binding.Unit) {
			return fmt.Errorf("%s.unit %q is invalid", prefix, binding.Unit)
		}
		if strings.TrimSpace(binding.RCON.Address) == "" {
			return fmt.Errorf("%s.rcon.address is required", prefix)
		}
		if binding.RCON.Password == "" {
			return fmt.Errorf("%s.rcon.password is required", prefix)
		}
		if binding.RCON.TimeoutSeconds < 0 {
			return fmt.Errorf("%s.rcon.timeoutSeconds cannot be negative", prefix)
		}
	}
	return nil
}

func (c Config) validateSources() error {
	hasInline := c.Bindings != nil
	hasDirectory := strings.TrimSpace(c.BindingsDir) != ""
	if hasInline == hasDirectory {
		return errors.New("exactly one of bindings or bindingsDir is required")
	}
	return nil
}

func loadBindingFragments(directory string) ([]BindingConfig, error) {
	info, err := os.Lstat(directory)
	if err != nil {
		return nil, fmt.Errorf("stat bindingsDir: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, errors.New("bindingsDir must be a real directory, not a symlink")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("bindingsDir permissions %04o are too open; remove group and world access", info.Mode().Perm())
	}

	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("read bindingsDir: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		return nil, errors.New("bindingsDir contains no *.json fragments")
	}

	bindings := make([]BindingConfig, 0, len(names))
	for _, name := range names {
		path := filepath.Join(directory, name)
		data, err := readSecureBindingFragment(path)
		if err != nil {
			return nil, fmt.Errorf("binding fragment %q: %w", name, err)
		}
		var binding BindingConfig
		if err := decodeStrictJSON(data, &binding); err != nil {
			return nil, fmt.Errorf("binding fragment %q: decode: %w", name, err)
		}
		bindings = append(bindings, binding)
	}
	return bindings, nil
}

func readSecureBindingFragment(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("must be a regular file, not a symlink")
	}
	if info.Mode().Perm() != 0o600 {
		return nil, fmt.Errorf("permissions %04o are invalid; use 0600", info.Mode().Perm())
	}

	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) {
		return nil, errors.New("file changed while opening")
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func decodeStrictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}

func validUnitName(unit string) bool {
	return serverUnitPattern.MatchString(unit) || legacyUnitPattern.MatchString(unit)
}

func (c Config) websocketURL() (string, error) {
	u, err := url.Parse(c.PanelURL)
	if err != nil || u.Host == "" {
		return "", errors.New("panelUrl must be an absolute http(s) or ws(s) URL")
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "ws", "wss":
	default:
		return "", errors.New("panelUrl must use http, https, ws, or wss")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/server-agent/connect"
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

func (c Config) heartbeatInterval() time.Duration {
	if c.HeartbeatIntervalSec == 0 {
		return 15 * time.Second
	}
	return time.Duration(c.HeartbeatIntervalSec) * time.Second
}

func (c Config) stateDirectory() string {
	if c.StateDir == "" {
		return "/var/lib/gravit-agent"
	}
	return c.StateDir
}

func (r RCONConfig) timeout() time.Duration {
	if r.TimeoutSeconds == 0 {
		return 10 * time.Second
	}
	return time.Duration(r.TimeoutSeconds) * time.Second
}
