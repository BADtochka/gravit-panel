BINARY := gravit-agent
BUILD_DIR := dist
LDFLAGS := -s -w

.PHONY: all build linux-amd64 linux-arm64 test clean

all: build

build: linux-amd64 linux-arm64

linux-amd64:
	mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY)-amd64 .

linux-arm64:
	mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY)-arm64 .

test:
	go test ./...

clean:
	rm -rf $(BUILD_DIR)
