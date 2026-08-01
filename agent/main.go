package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

func main() {
	configPath := flag.String("config", "/etc/gravit-agent/config.json", "path to agent JSON configuration")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	cfg, err := loadConfig(*configPath)
	if err != nil {
		logger.Error("load configuration", "error", err)
		os.Exit(1)
	}
	agents, err := newBindingAgents(cfg, logger)
	if err != nil {
		logger.Error("initialize agents", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var wg sync.WaitGroup
	for _, agent := range agents {
		wg.Add(1)
		go func() {
			defer wg.Done()
			agent.run(ctx)
		}()
	}
	logger.Info("agent started", "version", agentVersion, "bindings", len(agents))
	<-ctx.Done()
	logger.Info("agent stopping")
	wg.Wait()
}
