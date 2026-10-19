package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mau.fi/mautrix-meta/pkg/messagix/cookies"
	"go.mau.fi/mautrix-meta/pkg/messagix/loginerrors"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"
	"maunium.net/go/mautrix/bridgev2"
)

// fakeFlow is a scripted login state machine.
type fakeFlow struct {
	mu         sync.Mutex
	doLogin    func(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error)
	cancelStep func(ctx context.Context) error
	inputs     []map[string]string
}

func (f *fakeFlow) DoLoginSteps(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
	f.mu.Lock()
	f.inputs = append(f.inputs, input)
	f.mu.Unlock()
	return f.doLogin(ctx, input)
}

func (f *fakeFlow) CancelLoginStep(ctx context.Context) error {
	if f.cancelStep == nil {
		return errors.New("current login step cannot be cancelled")
	}
	return f.cancelStep(ctx)
}

type decodedResponse struct {
	ID        uint64      `json:"id"`
	OK        bool        `json:"ok"`
	Data      loginResult `json:"data"`
	Error     string      `json:"error"`
	ErrorCode string      `json:"errorCode"`
}

type harness struct {
	t   *testing.T
	out *bytes.Buffer
}

func newHarness(t *testing.T, flows ...*fakeFlow) *harness {
	t.Helper()
	out := &bytes.Buffer{}
	stdoutMu.Lock()
	previousStdout := stdout
	stdout = out
	stdoutMu.Unlock()
	previousNewFlow := newFlow
	next := 0
	newFlow = func(startParams) (loginFlow, error) {
		if next >= len(flows) {
			return nil, errors.New("no scripted flow left")
		}
		flow := flows[next]
		next++
		return flow, nil
	}
	session.close()
	t.Cleanup(func() {
		session.close()
		newFlow = previousNewFlow
		stdoutMu.Lock()
		stdout = previousStdout
		stdoutMu.Unlock()
	})
	return &harness{t: t, out: out}
}

func (h *harness) send(id uint64, method string, params interface{}) {
	h.t.Helper()
	req := &request{ID: id, Method: method}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			h.t.Fatal(err)
		}
		req.Params = raw
	}
	handleSafely(req)
}

// response waits for the response to request id.
func (h *harness) response(id uint64) decodedResponse {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		stdoutMu.Lock()
		lines := strings.Split(h.out.String(), "\n")
		stdoutMu.Unlock()
		for _, line := range lines {
			if strings.TrimSpace(line) == "" {
				continue
			}
			var resp decodedResponse
			if err := json.Unmarshal([]byte(line), &resp); err != nil {
				h.t.Fatalf("invalid response line %q: %v", line, err)
			}
			if resp.ID == id {
				return resp
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatalf("no response for request %d", id)
	return decodedResponse{}
}

func inputStep(id string) *bridgev2.LoginStep {
	return &bridgev2.LoginStep{
		Type:   bridgev2.LoginStepTypeUserInput,
		StepID: id,
		UserInputParams: &bridgev2.LoginUserInputParams{
			Fields: []bridgev2.LoginInputDataField{{ID: "password", Type: bridgev2.LoginInputFieldTypePassword}},
		},
	}
}

func waitStep() *bridgev2.LoginStep {
	return &bridgev2.LoginStep{
		Type:   bridgev2.LoginStepTypeDisplayAndWait,
		StepID: "fi.mau.meta.messengerlite.afad_wait",
		DisplayAndWaitParams: &bridgev2.LoginDisplayAndWaitParams{
			Type:      bridgev2.LoginDisplayTypeNothing,
			CanCancel: true,
		},
	}
}

func sessionCookies() *cookies.Cookies {
	result := &cookies.Cookies{Platform: types.MessengerLiteIOS}
	result.UpdateValues(map[cookies.MetaCookieName]string{"c_user": "100001", "xs": "secret", "fr": ""})
	return result
}

// blockUntilDone models the approval poll: it only returns when its context
// ends, mirroring messagix's AFAD loop.
func blockUntilDone(ctx context.Context) (*bridgev2.LoginStep, *cookies.Cookies, error) {
	<-ctx.Done()
	if errors.Is(context.Cause(ctx), bridgev2.ErrLoginStepCancelled) {
		return nil, nil, bridgev2.ErrLoginStepCancelled
	}
	return nil, nil, errors.New("login cancelled while waiting for approval: " + ctx.Err().Error())
}

func TestHelloAdvertisesLoginCapabilities(t *testing.T) {
	h := newHarness(t)
	h.send(1, "hello", nil)

	stdoutMu.Lock()
	line := strings.TrimSpace(h.out.String())
	stdoutMu.Unlock()
	var resp struct {
		OK   bool `json:"ok"`
		Data struct {
			ProtocolVersion int      `json:"protocolVersion"`
			BridgeVersion   string   `json:"bridgeVersion"`
			Capabilities    []string `json:"capabilities"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.OK || resp.Data.ProtocolVersion != protocolVersion || resp.Data.BridgeVersion != bridgeVersion {
		t.Fatalf("unexpected hello: %s", line)
	}
	for _, capability := range []string{"nativeLogin", "nativeLoginBack", "nativeLoginWait"} {
		found := false
		for _, advertised := range resp.Data.Capabilities {
			found = found || advertised == capability
		}
		if !found {
			t.Fatalf("hello does not advertise %s: %v", capability, resp.Data.Capabilities)
		}
	}
}

func TestLoginCompletesAndHandsCookiesOverOnce(t *testing.T) {
	flow := &fakeFlow{}
	flow.doLogin = func(_ context.Context, input map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
		if input["password"] == "" {
			return inputStep("credentials"), nil, nil
		}
		return nil, sessionCookies(), nil
	}
	h := newHarness(t, flow)

	h.send(1, "startNativeLogin", map[string]string{})
	if resp := h.response(1); !resp.OK || resp.Data.Step == nil || resp.Data.Step.StepID != "credentials" {
		t.Fatalf("start = %+v", resp)
	}
	h.send(2, "submitNativeLogin", map[string]interface{}{"input": map[string]string{"password": "pw"}})
	resp := h.response(2)
	if !resp.OK || !resp.Data.Complete {
		t.Fatalf("submit = %+v", resp)
	}
	if resp.Data.Cookies["c_user"] != "100001" || resp.Data.Cookies["xs"] != "secret" {
		t.Fatalf("cookies = %v", resp.Data.Cookies)
	}
	if _, present := resp.Data.Cookies["fr"]; present {
		t.Fatal("empty cookie values must be dropped")
	}

	h.send(3, "submitNativeLogin", map[string]interface{}{"input": map[string]string{"password": "pw"}})
	if resp := h.response(3); resp.OK || !strings.Contains(resp.Error, "not initialised") {
		t.Fatalf("submit after completion = %+v, want not initialised", resp)
	}
}

func TestFailedStartCanBeRetried(t *testing.T) {
	broken := &fakeFlow{doLogin: func(context.Context, map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
		return nil, nil, errors.New("facebook unavailable")
	}}
	working := &fakeFlow{doLogin: func(context.Context, map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
		return inputStep("credentials"), nil, nil
	}}
	h := newHarness(t, broken, working)

	h.send(1, "startNativeLogin", nil)
	if resp := h.response(1); resp.OK || !strings.Contains(resp.Error, "facebook unavailable") {
		t.Fatalf("start = %+v", resp)
	}
	h.send(2, "startNativeLogin", nil)
	if resp := h.response(2); !resp.OK || resp.Data.Step == nil {
		t.Fatalf("retried start = %+v", resp)
	}
}

// Bloks timers keep the context of the step that scheduled them (approval
// polling runs in a later step), so a returned step must not end it.
func TestStepContextOutlivesTheStep(t *testing.T) {
	var captured context.Context
	flow := &fakeFlow{doLogin: func(ctx context.Context, _ map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
		if captured == nil {
			captured = ctx
		}
		return waitStep(), nil, nil
	}}
	h := newHarness(t, flow)

	h.send(1, "startNativeLogin", nil)
	if resp := h.response(1); !resp.OK {
		t.Fatalf("start = %+v", resp)
	}
	if err := captured.Err(); err != nil {
		t.Fatalf("step context ended when the step returned: %v", err)
	}
	h.send(2, "cancelNativeLogin", nil)
	h.response(2)
	if captured.Err() == nil {
		t.Fatal("step context survived cancelNativeLogin")
	}
}

func TestWaitAnswersWaitingWhilePending(t *testing.T) {
	previous := waitPollInterval
	waitPollInterval = 20 * time.Millisecond
	t.Cleanup(func() { waitPollInterval = previous })

	flow := &fakeFlow{}
	flow.doLogin = func(ctx context.Context, _ map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
		flow.mu.Lock()
		calls := len(flow.inputs)
		flow.mu.Unlock()
		switch calls {
		case 1:
			return waitStep(), nil, nil
		case 2:
			return blockUntilDone(ctx)
		default:
			return nil, sessionCookies(), nil
		}
	}
	h := newHarness(t, flow)

	h.send(1, "startNativeLogin", nil)
	h.response(1)
	h.send(2, "waitNativeLogin", nil)
	resp := h.response(2)
	if !resp.OK || !resp.Data.Waiting || resp.Data.Step == nil || resp.Data.Step.Type != bridgev2.LoginStepTypeDisplayAndWait {
		t.Fatalf("elapsed wait = %+v, want waiting with the approval step", resp)
	}
	h.send(3, "waitNativeLogin", nil)
	if resp := h.response(3); !resp.OK || !resp.Data.Complete {
		t.Fatalf("approved wait = %+v", resp)
	}
}

func TestBackInterruptsPendingWait(t *testing.T) {
	waitEnded := make(chan struct{})
	backCalledAfterWait := false
	flow := &fakeFlow{}
	flow.doLogin = func(ctx context.Context, _ map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
		flow.mu.Lock()
		calls := len(flow.inputs)
		flow.mu.Unlock()
		switch calls {
		case 1:
			return waitStep(), nil, nil
		case 2:
			defer close(waitEnded)
			return blockUntilDone(ctx)
		default:
			return inputStep("choose_method"), nil, nil
		}
	}
	flow.cancelStep = func(context.Context) error {
		select {
		case <-waitEnded:
			backCalledAfterWait = true
		default:
		}
		return nil
	}
	h := newHarness(t, flow)

	h.send(1, "startNativeLogin", nil)
	h.response(1)
	h.send(2, "waitNativeLogin", nil)
	h.send(3, "backNativeLogin", nil)

	if resp := h.response(2); resp.OK || resp.ErrorCode != bridgev2.ErrLoginStepCancelled.ErrCode {
		t.Fatalf("interrupted wait = %+v, want %s", resp, bridgev2.ErrLoginStepCancelled.ErrCode)
	}
	resp := h.response(3)
	if !resp.OK || resp.Data.Step == nil || resp.Data.Step.StepID != "choose_method" {
		t.Fatalf("back = %+v", resp)
	}
	if !backCalledAfterWait {
		t.Fatal("CancelLoginStep ran while the wait was still using the flow")
	}
}

func TestStepsDoNotOverlap(t *testing.T) {
	release := make(chan struct{})
	flow := &fakeFlow{}
	flow.doLogin = func(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
		if input == nil {
			return inputStep("credentials"), nil, nil
		}
		<-release
		return inputStep("code"), nil, nil
	}
	h := newHarness(t, flow)

	h.send(1, "startNativeLogin", nil)
	h.response(1)
	h.send(2, "submitNativeLogin", map[string]interface{}{"input": map[string]string{"password": "pw"}})
	h.send(3, "submitNativeLogin", map[string]interface{}{"input": map[string]string{"password": "pw"}})
	if resp := h.response(3); resp.OK || !strings.Contains(resp.Error, "still running") {
		t.Fatalf("overlapping submit = %+v, want busy", resp)
	}
	h.send(4, "backNativeLogin", nil)
	if resp := h.response(4); resp.OK || !strings.Contains(resp.Error, "still running") {
		t.Fatalf("back during submit = %+v, want busy", resp)
	}
	close(release)
	if resp := h.response(2); !resp.OK || resp.Data.Step.StepID != "code" {
		t.Fatalf("submit = %+v", resp)
	}
}

func TestCancelInterruptsWaitAndDropsFlow(t *testing.T) {
	flow := &fakeFlow{}
	flow.doLogin = func(ctx context.Context, _ map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
		flow.mu.Lock()
		calls := len(flow.inputs)
		flow.mu.Unlock()
		if calls == 1 {
			return waitStep(), nil, nil
		}
		return blockUntilDone(ctx)
	}
	h := newHarness(t, flow)

	h.send(1, "startNativeLogin", nil)
	h.response(1)
	h.send(2, "waitNativeLogin", nil)
	h.send(3, "cancelNativeLogin", nil)
	if resp := h.response(3); !resp.OK {
		t.Fatalf("cancel = %+v", resp)
	}
	if resp := h.response(2); resp.OK {
		t.Fatalf("wait after cancel = %+v, want an error", resp)
	}
	h.send(4, "waitNativeLogin", nil)
	if resp := h.response(4); resp.OK || !strings.Contains(resp.Error, "not initialised") {
		t.Fatalf("wait after cancel = %+v, want not initialised", resp)
	}
}

func TestPanicInStepBecomesErrorAndDropsFlow(t *testing.T) {
	flow := &fakeFlow{}
	flow.doLogin = func(_ context.Context, input map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
		if input == nil {
			return inputStep("credentials"), nil, nil
		}
		panic("runtime error: invalid memory address or nil pointer dereference")
	}
	h := newHarness(t, flow)

	h.send(1, "startNativeLogin", nil)
	h.response(1)
	h.send(2, "submitNativeLogin", map[string]interface{}{"input": map[string]string{"password": "pw"}})
	if resp := h.response(2); resp.OK || !strings.Contains(resp.Error, "internal login error") {
		t.Fatalf("panicking submit = %+v", resp)
	}
	h.send(3, "hello", nil)
	if resp := h.response(3); !resp.OK {
		t.Fatalf("hello after panic = %+v", resp)
	}
	h.send(4, "submitNativeLogin", map[string]interface{}{"input": map[string]string{"password": "pw"}})
	if resp := h.response(4); resp.OK || !strings.Contains(resp.Error, "not initialised") {
		t.Fatalf("submit after panic = %+v, want not initialised", resp)
	}
}

func TestLoginErrorsCarryTheirCode(t *testing.T) {
	flow := &fakeFlow{doLogin: func(context.Context, map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
		return nil, nil, fmt.Errorf("submitting password: %w", loginerrors.RateLimited)
	}}
	h := newHarness(t, flow)

	h.send(1, "startNativeLogin", nil)
	resp := h.response(1)
	if resp.OK || resp.ErrorCode != loginerrors.RateLimited.ErrCode || !strings.Contains(resp.Error, "rate-limiting") {
		t.Fatalf("rate limited = %+v", resp)
	}
}

func TestStepTimeoutEndsAStuckStep(t *testing.T) {
	previous := stepTimeout
	stepTimeout = 20 * time.Millisecond
	t.Cleanup(func() { stepTimeout = previous })

	flow := &fakeFlow{doLogin: func(ctx context.Context, _ map[string]string) (*bridgev2.LoginStep, *cookies.Cookies, error) {
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}}
	h := newHarness(t, flow)

	h.send(1, "startNativeLogin", nil)
	if resp := h.response(1); resp.OK || !strings.Contains(resp.Error, "timed out") {
		t.Fatalf("stuck start = %+v, want timeout", resp)
	}
}

func TestSubmitRejectsOversizedInput(t *testing.T) {
	h := newHarness(t)
	tooMany := map[string]string{}
	for i := 0; i <= maxInputFields; i++ {
		tooMany[strings.Repeat("k", i+1)] = "v"
	}
	h.send(1, "submitNativeLogin", map[string]interface{}{"input": tooMany})
	if resp := h.response(1); resp.OK || !strings.Contains(resp.Error, "too many") {
		t.Fatalf("too many inputs = %+v", resp)
	}
	h.send(2, "submitNativeLogin", map[string]interface{}{"input": map[string]string{"code": strings.Repeat("1", maxInputValue+1)}})
	if resp := h.response(2); resp.OK || !strings.Contains(resp.Error, "size limit") {
		t.Fatalf("oversized input = %+v", resp)
	}
}

func TestServeRequestsRejectsOversizedLine(t *testing.T) {
	h := newHarness(t)
	input := strings.NewReader(`{"id":1,"method":"hello"}` + "\n" + strings.Repeat("x", 128) + "\n")
	if err := serveRequests(input, 64); err == nil {
		t.Fatal("serveRequests accepted a line above the limit")
	}
	if resp := h.response(1); !resp.OK {
		t.Fatalf("hello before the oversized line = %+v", resp)
	}
}

func TestNewFlowRejectsBadInputWithoutEchoingProxy(t *testing.T) {
	if _, err := newMessengerLiteFlow(startParams{Platform: "windows"}); err == nil {
		t.Fatal("unsupported platform accepted")
	}
	_, err := newMessengerLiteFlow(startParams{ProxyURL: "ftp://user:hunter2@proxy.example:21"})
	if err == nil {
		t.Fatal("unsupported proxy scheme accepted")
	}
	if strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("proxy error leaks credentials: %v", err)
	}
	flow, err := newMessengerLiteFlow(startParams{ProxyURL: "socks5://127.0.0.1:1080", Platform: "android"})
	if err != nil || flow == nil {
		t.Fatalf("socks5 android flow: %v", err)
	}
}
