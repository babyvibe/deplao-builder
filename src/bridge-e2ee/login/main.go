// Command fbchat-login-bridge runs Deplao's Facebook credential login
// ("Đăng nhập tài khoản", Messenger Lite) wizard.
//
// DEPLAO_ADAPTER: this helper is not part of fbchat-v2. The E2EE bridge stays
// on the mautrix/meta revision that fbchat-v2 pins, but Facebook's current Bloks
// login pages need a newer interpreter than that revision ships (it panicked in
// bk.action.core.GetArg and lacked bk.action.array.Get). This separate process
// links a newer mautrix/meta, runs only the login state machine and hands the
// session cookies back. The account itself then connects through the E2EE
// bridge, so its encryption code is unchanged.
//
// It speaks the E2EE bridge's line-delimited JSON-RPC so Electron drives both
// with the same client:
//
//	hello                          handshake
//	startNativeLogin               {proxyUrl?, platform?}
//	submitNativeLogin              {input} for a user_input or cookies step
//	waitNativeLogin                poll a display_and_wait step (approval on
//	                               another device); {waiting:true} while pending
//	backNativeLogin                "Try another way" on a step with can_cancel
//	cancelNativeLogin, disconnect  drop the wizard
//
// Steps run in the background so that cancel and back are answered while an
// approval wait is pending. Responses carry the request id and may arrive out
// of order.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/bloks"
	"go.mau.fi/mautrix-meta/pkg/messagix/cookies"
	"go.mau.fi/mautrix-meta/pkg/messagix/loginerrors"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"
	"go.mau.fi/util/exhttp"
	"maunium.net/go/mautrix/bridgev2"
)

// bridgeVersion is set via -ldflags "-X main.bridgeVersion=..." by the build
// script; it follows the vendored fbchat-v2 version.
var bridgeVersion = "2.3.2-dev"

const (
	protocolVersion = 2
	// Login inputs are a handful of short strings.
	maxRequestBytes = 1 << 20
	maxInputFields  = 8
	maxInputKey     = 128
	// reCAPTCHA tokens run to a few KiB.
	maxInputValue = 16 << 10
)

var (
	// stepTimeout stays below Electron's 120 s RPC timeout, so a stuck step
	// unwinds here first.
	stepTimeout = 110 * time.Second
	// waitPollInterval: a wait answers {waiting:true} after this long and
	// Electron polls again. The approval request itself stays pending.
	waitPollInterval = 90 * time.Second
)

// capabilities advertised in hello. nativeLoginBack: leave the current MFA step
// for another method. nativeLoginWait: display_and_wait steps are polled with
// waitNativeLogin.
var capabilities = []string{"nativeLogin", "nativeLoginBack", "nativeLoginWait"}

var (
	errNotInitialised = errors.New("native login is not initialised")
	errAlreadyActive  = errors.New("native login is already active")
	errBusy           = errors.New("another native login step is still running")
	errStepTimeout    = errors.New("native login step timed out")
	errLoginCancelled = errors.New("native login was cancelled")
	errWaitElapsed    = errors.New("approval wait elapsed")
)

type request struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type response struct {
	ID    uint64      `json:"id"`
	OK    bool        `json:"ok"`
	Data  interface{} `json:"data,omitempty"`
	Error string      `json:"error,omitempty"`
	// ErrorCode is the mautrix error code of a login error, e.g.
	// FI.MAU.META_CHECKPOINT_ERROR, so Electron can explain it to the user.
	ErrorCode string `json:"errorCode,omitempty"`
}

type startParams struct {
	ProxyURL string `json:"proxyUrl,omitempty"`
	// "ios" (default) or "android": which Messenger Lite client to present as.
	Platform string `json:"platform,omitempty"`
}

type submitParams struct {
	Input map[string]string `json:"input"`
}

type loginResult struct {
	Complete bool `json:"complete"`
	// Waiting: the approval is still pending; call waitNativeLogin again.
	Waiting bool                `json:"waiting,omitempty"`
	Step    *bridgev2.LoginStep `json:"step,omitempty"`
	Cookies map[string]string   `json:"cookies,omitempty"`
}

// loginFlow is the part of messagix's Messenger Lite login used here.
type loginFlow interface {
	DoLoginSteps(ctx context.Context, userInput map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error)
	CancelLoginStep(ctx context.Context) error
}

// operation is one step running against the flow.
type operation struct {
	flow   loginFlow
	ctx    context.Context
	cancel context.CancelCauseFunc
	// wait: a waitNativeLogin poll, which backNativeLogin may interrupt.
	wait bool
	// discardOnError: a failed start leaves nothing to resume.
	discardOnError bool
	// previous is an interrupted wait that has to end before this step runs.
	previous <-chan struct{}
	done     chan struct{}
}

// loginSession is the active wizard. The Bloks browser behind flow is not safe
// for concurrent use, so at most one operation runs at a time.
type loginSession struct {
	mu   sync.Mutex
	flow loginFlow
	// ctx lives as long as flow. Operation contexts derive from it and are not
	// cancelled when a step returns: Bloks timers (approval polling) keep the
	// context of the step that scheduled them and use it in later steps.
	ctx      context.Context
	stop     context.CancelFunc
	lastStep *bridgev2.LoginStep
	op       *operation
}

var (
	stdoutMu sync.Mutex
	stdout   io.Writer = os.Stdout
	session            = &loginSession{}
	// newFlow and handleRequest are test seams.
	newFlow       = newMessengerLiteFlow
	handleRequest = handle
)

func writeJSON(v interface{}) {
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	enc := json.NewEncoder(stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func ok(id uint64, data interface{}) {
	writeJSON(response{ID: id, OK: true, Data: data})
}

func fail(id uint64, err error) {
	resp := response{ID: id, OK: false, Error: err.Error()}
	var respErr bridgev2.RespError
	if errors.As(err, &respErr) {
		resp.ErrorCode = respErr.ErrCode
	}
	writeJSON(resp)
}

func newMessengerLiteFlow(params startParams) (loginFlow, error) {
	platform := types.MessengerLiteIOS
	switch strings.ToLower(strings.TrimSpace(params.Platform)) {
	case "", "ios":
	case "android":
		platform = types.MessengerLiteAndroid
	default:
		return nil, fmt.Errorf("unsupported login platform %q", params.Platform)
	}
	settings, err := exhttp.SensibleClientSettings.WithProxy(params.ProxyURL)
	if err != nil {
		// The parse error would echo the proxy URL, credentials included.
		return nil, errors.New("invalid login proxy URL")
	}
	loginCookies := &cookies.Cookies{Platform: platform}
	loginCookies.UpdateValues(map[cookies.MetaCookieName]string{})
	// Warn level only: debug and trace output include raw Bloks requests, and the
	// password step carries credentials.
	logger := zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, NoColor: true}).
		Level(zerolog.WarnLevel).With().Timestamp().Logger()
	client := messagix.NewClient(loginCookies, logger, &messagix.Config{ClientSettings: settings})
	if client.MessengerLite == nil {
		return nil, errors.New("messenger lite login is unavailable")
	}
	return client.MessengerLite, nil
}

// open installs flow and reserves it for its first step.
func (s *loginSession) open(flow loginFlow) (*operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.flow != nil {
		return nil, errAlreadyActive
	}
	s.ctx, s.stop = context.WithCancel(context.Background())
	s.flow = flow
	s.lastStep = nil
	op := s.newOperationLocked(false)
	op.discardOnError = true
	return op, nil
}

// begin reserves the flow for one step. interruptWait lets "back" end a
// pending approval wait first; any other running step makes it fail.
func (s *loginSession) begin(wait, interruptWait bool) (*operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.flow == nil {
		return nil, errNotInitialised
	}
	var previous <-chan struct{}
	if s.op != nil {
		if !interruptWait || !s.op.wait {
			return nil, errBusy
		}
		s.op.cancel(bridgev2.ErrLoginStepCancelled)
		previous = s.op.done
	}
	op := s.newOperationLocked(wait)
	op.previous = previous
	return op, nil
}

func (s *loginSession) newOperationLocked(wait bool) *operation {
	ctx, cancel := context.WithCancelCause(s.ctx)
	op := &operation{flow: s.flow, ctx: ctx, cancel: cancel, wait: wait, done: make(chan struct{})}
	s.op = op
	return op
}

// finish releases the flow and records the outcome. A flow that was cancelled
// or replaced meanwhile is left alone.
func (s *loginSession) finish(op *operation, result *loginResult, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.op == op {
		s.op = nil
	}
	if s.flow != op.flow {
		return
	}
	switch {
	case err != nil:
		if op.discardOnError {
			s.closeLocked()
		}
	case result.Complete:
		// Cookies are handed over exactly once; a finished flow cannot be resumed.
		s.closeLocked()
	case result.Step != nil && !result.Waiting:
		s.lastStep = result.Step
	}
}

func (s *loginSession) currentStep(flow loginFlow) *bridgev2.LoginStep {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.flow != flow {
		return nil
	}
	return s.lastStep
}

// discard drops flow if it is still the active one.
func (s *loginSession) discard(flow loginFlow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.flow == flow {
		s.closeLocked()
	}
}

// close drops the active flow and interrupts its running step.
func (s *loginSession) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeLocked()
}

func (s *loginSession) closeLocked() {
	if s.op != nil {
		s.op.cancel(errLoginCancelled)
		s.op = nil
	}
	if s.stop != nil {
		s.stop()
	}
	s.flow, s.ctx, s.stop, s.lastStep = nil, nil, nil, nil
}

// run executes step in the background and answers request id when it ends.
func (s *loginSession) run(id uint64, op *operation, step func() (*loginResult, error)) {
	go func() {
		defer close(op.done)
		if op.previous != nil {
			<-op.previous
		}
		result, err := s.runStep(op, step)
		s.finish(op, result, err)
		if err != nil {
			fail(id, err)
			return
		}
		ok(id, result)
	}()
}

// runStep turns a panic in the login library into an error. The flow may be
// half-updated afterwards, so it is discarded.
func (s *loginSession) runStep(op *operation, step func() (*loginResult, error)) (result *loginResult, err error) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		fmt.Fprintf(os.Stderr, "panic in native login step: %v\n%s\n", recovered, debug.Stack())
		s.discard(op.flow)
		result, err = nil, fmt.Errorf("internal login error: %v", recovered)
	}()
	result, err = step()
	if err == nil && result == nil {
		err = errors.New("native login step returned no result")
	}
	return result, err
}

// bounded runs fn under the step timeout. Only the timeout cancels the
// operation context; a normal return leaves it alive (see loginSession.ctx).
func bounded(op *operation, fn func(context.Context) (*loginResult, error)) (*loginResult, error) {
	timer := time.AfterFunc(stepTimeout, func() { op.cancel(errStepTimeout) })
	defer timer.Stop()
	result, err := fn(op.ctx)
	if err != nil && errors.Is(context.Cause(op.ctx), errStepTimeout) {
		return nil, errStepTimeout
	}
	return result, err
}

// advance runs the state machine until it needs input or yields cookies. Input
// values are never logged: they may be passwords or one-time codes.
func advance(ctx context.Context, flow loginFlow, input map[string]string) (*loginResult, error) {
	step, sessionCookies, err := flow.DoLoginSteps(ctx, input)
	if err != nil {
		var checkpoint bloks.CheckpointError
		if errors.As(err, &checkpoint) {
			// Keep Facebook's explanation, tagged with the checkpoint code.
			return nil, loginerrors.WithMessage(loginerrors.Checkpoint, checkpoint.Error())
		}
		return nil, err
	}
	if step != nil {
		return &loginResult{Step: step}, nil
	}
	if sessionCookies == nil {
		return nil, errors.New("native login completed without session cookies")
	}
	values := sessionCookies.GetAll()
	result := make(map[string]string, len(values))
	for name, value := range values {
		if value != "" {
			result[string(name)] = value
		}
	}
	return &loginResult{Complete: true, Cookies: result}, nil
}

func validateInput(input map[string]string) error {
	if len(input) > maxInputFields {
		return errors.New("too many native login inputs")
	}
	for key, value := range input {
		if key == "" || len(key) > maxInputKey || len(value) > maxInputValue {
			return errors.New("native login input exceeds size limit")
		}
	}
	return nil
}

func handle(req *request) {
	switch req.Method {
	case "hello":
		ok(req.ID, map[string]interface{}{
			"protocolVersion":      protocolVersion,
			"bridgeVersion":        bridgeVersion,
			"capabilities":         capabilities,
			"maxDecodedMediaBytes": 0,
		})

	case "startNativeLogin":
		var params startParams
		if len(req.Params) > 0 {
			if err := json.Unmarshal(req.Params, &params); err != nil {
				fail(req.ID, err)
				return
			}
		}
		created, err := newFlow(params)
		if err != nil {
			fail(req.ID, err)
			return
		}
		op, err := session.open(created)
		if err != nil {
			fail(req.ID, err)
			return
		}
		session.run(req.ID, op, func() (*loginResult, error) {
			return bounded(op, func(ctx context.Context) (*loginResult, error) {
				return advance(ctx, op.flow, nil)
			})
		})

	case "submitNativeLogin":
		var params submitParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			fail(req.ID, err)
			return
		}
		if err := validateInput(params.Input); err != nil {
			fail(req.ID, err)
			return
		}
		op, err := session.begin(false, false)
		if err != nil {
			fail(req.ID, err)
			return
		}
		// A rejected code keeps the state machine where it was so the user can
		// retry; only a completed login discards it (see finish).
		session.run(req.ID, op, func() (*loginResult, error) {
			return bounded(op, func(ctx context.Context) (*loginResult, error) {
				return advance(ctx, op.flow, params.Input)
			})
		})

	case "waitNativeLogin":
		op, err := session.begin(true, false)
		if err != nil {
			fail(req.ID, err)
			return
		}
		session.run(req.ID, op, func() (*loginResult, error) {
			timer := time.AfterFunc(waitPollInterval, func() { op.cancel(errWaitElapsed) })
			defer timer.Stop()
			result, err := advance(op.ctx, op.flow, nil)
			if err != nil && errors.Is(context.Cause(op.ctx), errWaitElapsed) {
				return &loginResult{Waiting: true, Step: session.currentStep(op.flow)}, nil
			}
			return result, err
		})

	case "backNativeLogin":
		op, err := session.begin(false, true)
		if err != nil {
			fail(req.ID, err)
			return
		}
		session.run(req.ID, op, func() (*loginResult, error) {
			return bounded(op, func(ctx context.Context) (*loginResult, error) {
				if err := op.flow.CancelLoginStep(ctx); err != nil {
					return nil, err
				}
				return advance(ctx, op.flow, nil)
			})
		})

	case "cancelNativeLogin", "disconnect":
		session.close()
		ok(req.ID, map[string]interface{}{})

	default:
		fail(req.ID, fmt.Errorf("unknown method: %s", req.Method))
	}
}

// handleSafely turns a panic while dispatching a request into an error
// response and drops the login state, which may be half-updated.
func handleSafely(req *request) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		fmt.Fprintf(os.Stderr, "panic in %s: %v\n%s\n", req.Method, recovered, debug.Stack())
		session.close()
		fail(req.ID, fmt.Errorf("internal login error in %s: %v", req.Method, recovered))
	}()
	handleRequest(req)
}

func serveRequests(input io.Reader, maxBytes int) error {
	if maxBytes <= 0 {
		return errors.New("max request size must be positive")
	}
	initialBufferSize := 64 * 1024
	if maxBytes < initialBufferSize {
		initialBufferSize = maxBytes
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, initialBufferSize), maxBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			fail(0, fmt.Errorf("invalid json: %w", err))
			continue
		}
		handleSafely(&req)
	}
	return scanner.Err()
}

func main() {
	defer session.close()
	if err := serveRequests(os.Stdin, maxRequestBytes); err != nil {
		fail(0, fmt.Errorf("stdin request exceeds the 1 MiB limit or could not be read: %w", err))
	}
}
