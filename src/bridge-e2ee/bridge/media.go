package bridge

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waConsumerApplication"
	"go.mau.fi/whatsmeow/proto/waMediaTransport"
	"go.mau.fi/whatsmeow/proto/waMsgApplication"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/socket"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

const maxDownloadedMediaSize int64 = 100 * 1024 * 1024

var allowedMediaHosts = []string{
	"facebook.com",
	"fbcdn.net",
	"fbsbx.com",
	"messenger.com",
}

func validateMediaURL(rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid media URL: %w", err)
	}
	if parsed.Scheme != "https" || parsed.User != nil || parsed.Hostname() == "" {
		return nil, fmt.Errorf("media URL must be an HTTPS URL without user info")
	}
	if parsed.Port() != "" && parsed.Port() != "443" {
		return nil, fmt.Errorf("media URL uses a disallowed port")
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	for _, allowed := range allowedMediaHosts {
		if host == allowed || strings.HasSuffix(host, "."+allowed) {
			return parsed, nil
		}
	}
	return nil, fmt.Errorf("media host is not trusted: %s", host)
}

// UploadMediaOptions for uploading media
type UploadMediaOptions struct {
	ThreadID int64  `json:"threadId"`
	Filename string `json:"filename"`
	MimeType string `json:"mimeType"`
	Data     []byte `json:"data"`
	IsVoice  bool   `json:"isVoice"`
}

// UploadMediaResult result of uploading media
type UploadMediaResult struct {
	FbID     int64  `json:"fbId"`
	Filename string `json:"filename"`
}

// UploadMedia uploads media to Messenger
func (c *Client) UploadMedia(opts *UploadMediaOptions) (*UploadMediaResult, error) {
	media := &messagix.MercuryUploadMedia{
		Filename:    opts.Filename,
		MimeType:    opts.MimeType,
		MediaData:   opts.Data,
		IsVoiceClip: opts.IsVoice,
	}

	resp, err := c.Messagix.SendMercuryUploadRequest(c.ctx, opts.ThreadID, media)
	if err != nil {
		return nil, err
	}

	var fbid int64
	if resp.Payload.RealMetadata != nil {
		fbid = resp.Payload.RealMetadata.GetFbId()
	}

	return &UploadMediaResult{
		FbID:     fbid,
		Filename: opts.Filename,
	}, nil
}

// SendMediaOptions for sending media
type SendMediaOptions struct {
	ThreadID   int64   `json:"threadId"`
	MediaFbIds []int64 `json:"mediaFbIds"`
	Caption    string  `json:"caption"`
	ReplyToID  string  `json:"replyToId,omitempty"`
}

// SendMedia sends media that has been uploaded
func (c *Client) SendMedia(opts *SendMediaOptions) (*SendMessageResult, error) {
	return c.SendMessage(&SendMessageOptions{
		ThreadID:        opts.ThreadID,
		Text:            opts.Caption,
		AttachmentFbIds: opts.MediaFbIds,
		ReplyToID:       opts.ReplyToID,
	})
}

// SendStickerOptions for sending stickers
type SendStickerOptions struct {
	ThreadID  int64  `json:"threadId"`
	StickerID int64  `json:"stickerId"`
	ReplyToID string `json:"replyToId,omitempty"`
}

// SendSticker sends a sticker
func (c *Client) SendSticker(opts *SendStickerOptions) (*SendMessageResult, error) {
	return c.SendMessage(&SendMessageOptions{
		ThreadID:  opts.ThreadID,
		StickerID: opts.StickerID,
		ReplyToID: opts.ReplyToID,
	})
}

// SendImageOptions for sending images
type SendImageOptions struct {
	ThreadID  int64  `json:"threadId"`
	Data      []byte `json:"data"`
	Filename  string `json:"filename"`
	Caption   string `json:"caption"`
	ReplyToID string `json:"replyToId,omitempty"`
}

// SendImage sends an image
func (c *Client) SendImage(opts *SendImageOptions) (*SendMessageResult, error) {
	mimeType := "image/jpeg"
	if strings.HasSuffix(strings.ToLower(opts.Filename), ".png") {
		mimeType = "image/png"
	} else if strings.HasSuffix(strings.ToLower(opts.Filename), ".gif") {
		mimeType = "image/gif"
	} else if strings.HasSuffix(strings.ToLower(opts.Filename), ".webp") {
		mimeType = "image/webp"
	}

	uploadResult, err := c.UploadMedia(&UploadMediaOptions{
		ThreadID: opts.ThreadID,
		Filename: opts.Filename,
		MimeType: mimeType,
		Data:     opts.Data,
		IsVoice:  false,
	})
	if err != nil {
		return nil, err
	}

	return c.SendMedia(&SendMediaOptions{
		ThreadID:   opts.ThreadID,
		MediaFbIds: []int64{uploadResult.FbID},
		Caption:    opts.Caption,
		ReplyToID:  opts.ReplyToID,
	})
}

// SendVideoOptions for sending videos
type SendVideoOptions struct {
	ThreadID  int64  `json:"threadId"`
	Data      []byte `json:"data"`
	Filename  string `json:"filename"`
	Caption   string `json:"caption"`
	ReplyToID string `json:"replyToId,omitempty"`
}

// SendVideo sends a video
func (c *Client) SendVideo(opts *SendVideoOptions) (*SendMessageResult, error) {
	uploadResult, err := c.UploadMedia(&UploadMediaOptions{
		ThreadID: opts.ThreadID,
		Filename: opts.Filename,
		MimeType: "video/mp4",
		Data:     opts.Data,
		IsVoice:  false,
	})
	if err != nil {
		return nil, err
	}

	return c.SendMedia(&SendMediaOptions{
		ThreadID:   opts.ThreadID,
		MediaFbIds: []int64{uploadResult.FbID},
		Caption:    opts.Caption,
		ReplyToID:  opts.ReplyToID,
	})
}

// SendVoiceOptions for sending voice messages
type SendVoiceOptions struct {
	ThreadID  int64  `json:"threadId"`
	Data      []byte `json:"data"`
	Filename  string `json:"filename"`
	ReplyToID string `json:"replyToId,omitempty"`
}

// SendVoice sends a voice message
func (c *Client) SendVoice(opts *SendVoiceOptions) (*SendMessageResult, error) {
	uploadResult, err := c.UploadMedia(&UploadMediaOptions{
		ThreadID: opts.ThreadID,
		Filename: opts.Filename,
		MimeType: "audio/mpeg",
		Data:     opts.Data,
		IsVoice:  true,
	})
	if err != nil {
		return nil, err
	}

	return c.SendMedia(&SendMediaOptions{
		ThreadID:   opts.ThreadID,
		MediaFbIds: []int64{uploadResult.FbID},
		ReplyToID:  opts.ReplyToID,
	})
}

// SendFileOptions for sending files
type SendFileOptions struct {
	ThreadID  int64  `json:"threadId"`
	Data      []byte `json:"data"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mimeType"`
	Caption   string `json:"caption"`
	ReplyToID string `json:"replyToId,omitempty"`
}

// SendFile sends a file
func (c *Client) SendFile(opts *SendFileOptions) (*SendMessageResult, error) {
	uploadResult, err := c.UploadMedia(&UploadMediaOptions{
		ThreadID: opts.ThreadID,
		Filename: opts.Filename,
		MimeType: opts.MimeType,
		Data:     opts.Data,
		IsVoice:  false,
	})
	if err != nil {
		return nil, err
	}

	return c.SendMedia(&SendMediaOptions{
		ThreadID:   opts.ThreadID,
		MediaFbIds: []int64{uploadResult.FbID},
		Caption:    opts.Caption,
		ReplyToID:  opts.ReplyToID,
	})
}

// DownloadMedia downloads media from a URL
func (c *Client) DownloadMedia(rawURL string) ([]byte, error) {
	parsed, err := validateMediaURL(rawURL)
	if err != nil {
		return nil, err
	}
	client := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many media redirects")
			}
			_, redirectErr := validateMediaURL(req.URL.String())
			return redirectErr
		},
	}
	resp, err := client.Get(parsed.String())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("media download returned HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > maxDownloadedMediaSize {
		return nil, fmt.Errorf("media exceeds the 100 MiB limit")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxDownloadedMediaSize+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxDownloadedMediaSize {
		return nil, fmt.Errorf("media exceeds the 100 MiB limit")
	}
	return data, nil
}

// ForwardMessageOptions for forwarding messages
type ForwardMessageOptions struct {
	ToThreadID     int64  `json:"toThreadId"`
	ForwardedMsgID string `json:"forwardedMsgId"`
}

// ForwardMessage forwards a message to another thread
func (c *Client) ForwardMessage(opts *ForwardMessageOptions) (*SendMessageResult, error) {
	return c.SendMessage(&SendMessageOptions{
		ThreadID: opts.ToThreadID,
		Text:     "", // Will use ForwardedMsgId
	})
}

// CreatePollOptions for creating polls
type CreatePollOptions struct {
	ThreadID int64    `json:"threadId"`
	Question string   `json:"question"`
	Options  []string `json:"options"`
}

// CreatePoll creates a poll in a thread
func (c *Client) CreatePoll(opts *CreatePollOptions) error {
	task := &socket.CreatePollTask{
		ThreadKey:    opts.ThreadID,
		QuestionText: opts.Question,
		Options:      opts.Options,
		SyncGroup:    1,
	}
	_, err := c.Messagix.ExecuteTasks(c.ctx, task)
	return err
}

// UpdatePollOptions for updating polls
type UpdatePollOptions struct {
	ThreadID        int64   `json:"threadId"`
	PollID          int64   `json:"pollId"`
	SelectedOptions []int64 `json:"selectedOptions"`
}

// UpdatePoll votes on a poll
func (c *Client) UpdatePoll(opts *UpdatePollOptions) error {
	task := &socket.UpdatePollTask{
		ThreadKey:       opts.ThreadID,
		PollID:          opts.PollID,
		SelectedOptions: opts.SelectedOptions,
		SyncGroup:       1,
	}
	_, err := c.Messagix.ExecuteTasks(c.ctx, task)
	return err
}

// MuteThreadOptions for muting threads
type MuteThreadOptions struct {
	ThreadID    int64 `json:"threadId"`
	MuteSeconds int64 `json:"muteSeconds"` // -1 for forever, 0 to unmute
}

// MuteThread mutes a thread
func (c *Client) MuteThread(opts *MuteThreadOptions) error {
	task := &socket.MuteThreadTask{
		ThreadKey:        opts.ThreadID,
		MuteExpireTimeMS: opts.MuteSeconds * 1000,
		SyncGroup:        1,
	}
	_, err := c.Messagix.ExecuteTasks(c.ctx, task)
	return err
}

// SetGroupPhotoOptions for setting group photo
type SetGroupPhotoOptions struct {
	ThreadID int64  `json:"threadId"`
	Data     []byte `json:"data"`
	MimeType string `json:"mimeType"`
}

// SetGroupPhoto sets the group photo/avatar
func (c *Client) SetGroupPhoto(opts *SetGroupPhotoOptions) error {
	// Upload the image first
	media := &messagix.MercuryUploadMedia{
		Filename:  "group_photo.jpg",
		MimeType:  opts.MimeType,
		MediaData: opts.Data,
	}

	resp, err := c.Messagix.SendMercuryUploadRequest(c.ctx, opts.ThreadID, media)
	if err != nil {
		return fmt.Errorf("failed to upload group photo: %w", err)
	}

	var imageID int64
	if resp.Payload.RealMetadata != nil {
		imageID = resp.Payload.RealMetadata.GetFbId()
	}
	if imageID == 0 {
		return fmt.Errorf("no image ID received from upload")
	}

	// Set the thread image
	task := &socket.SetThreadImageTask{
		ThreadKey: opts.ThreadID,
		ImageID:   imageID,
		SyncGroup: 1,
	}
	_, err = c.Messagix.ExecuteTasks(c.ctx, task)
	return err
}

// RenameThreadOptions for renaming threads
type RenameThreadOptions struct {
	ThreadID int64  `json:"threadId"`
	NewName  string `json:"newName"`
}

// RenameThread renames a group thread
func (c *Client) RenameThread(opts *RenameThreadOptions) error {
	task := &socket.RenameThreadTask{
		ThreadKey:  opts.ThreadID,
		ThreadName: opts.NewName,
		SyncGroup:  1,
	}
	_, err := c.Messagix.ExecuteTasks(c.ctx, task)
	return err
}

// DeleteThreadOptions for deleting threads
type DeleteThreadOptions struct {
	ThreadID int64 `json:"threadId"`
}

// DeleteThread deletes a thread
func (c *Client) DeleteThread(opts *DeleteThreadOptions) error {
	task := &socket.DeleteThreadTask{
		ThreadKey: opts.ThreadID,
		SyncGroup: 1,
	}
	_, err := c.Messagix.ExecuteTasks(c.ctx, task)
	return err
}

// SearchUsersOptions for searching users
type SearchUsersOptions struct {
	Query string `json:"query"`
}

// SearchUser represents a search result
type SearchUser struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Username string `json:"username"`
}

// SearchUsers searches for users
func (c *Client) SearchUsers(opts *SearchUsersOptions) ([]*SearchUser, error) {
	task := &socket.SearchUserTask{
		Query:          opts.Query,
		SupportedTypes: []table.SearchType{table.SearchTypeContact, table.SearchTypeNonContact},
		SurfaceType:    15,
	}
	tbl, err := c.Messagix.ExecuteTasks(c.ctx, task)
	if err != nil {
		return nil, err
	}

	users := make([]*SearchUser, 0)
	if tbl != nil {
		for _, u := range tbl.LSInsertSearchResult {
			// Parse ResultId as int64
			id, _ := strconv.ParseInt(u.ResultId, 10, 64)
			users = append(users, &SearchUser{
				ID:   id,
				Name: u.DisplayName,
			})
		}
	}
	return users, nil
}

// CreateThreadOptions for creating a 1:1 thread with a user
type CreateThreadOptions struct {
	UserID int64 `json:"userId"`
}

// CreateThreadResult result of creating a thread
type CreateThreadResult struct {
	ThreadID int64 `json:"threadId"`
}

// CreateThread creates a 1:1 thread with a user
func (c *Client) CreateThread(opts *CreateThreadOptions) (*CreateThreadResult, error) {
	task := &socket.CreateThreadTask{
		ThreadFBID:                opts.UserID,
		ForceUpsert:               1,
		UseOpenMessengerTransport: 0,
		SyncGroup:                 1,
		MetadataOnly:              0,
		PreviewOnly:               0,
	}
	tbl, err := c.Messagix.ExecuteTasks(c.ctx, task)
	if err != nil {
		return nil, err
	}

	var threadID int64
	if tbl != nil && len(tbl.LSDeleteThenInsertThread) > 0 {
		threadID = tbl.LSDeleteThenInsertThread[0].ThreadKey
	} else {
		// If no thread returned, use user ID as thread ID (1:1 chat)
		threadID = opts.UserID
	}

	return &CreateThreadResult{ThreadID: threadID}, nil
}

// ContactInfo represents detailed user/contact information
type ContactInfo struct {
	ID                int64  `json:"id"`
	Name              string `json:"name"`
	FirstName         string `json:"firstName,omitempty"`
	Username          string `json:"username,omitempty"`
	ProfilePictureUrl string `json:"profilePictureUrl,omitempty"`
	IsMessengerUser   bool   `json:"isMessengerUser,omitempty"`
	IsVerified        bool   `json:"isVerified,omitempty"`
	Gender            int64  `json:"gender,omitempty"`
	CanViewerMessage  bool   `json:"canViewerMessage,omitempty"`
}

// GetUserInfoOptions for getting user info
type GetUserInfoOptions struct {
	UserID int64 `json:"userId"`
}

// GetUserInfo gets detailed information about a user
func (c *Client) GetUserInfo(opts *GetUserInfoOptions) (*ContactInfo, error) {
	task := &socket.GetContactsFullTask{
		ContactID: opts.UserID,
	}
	tbl, err := c.Messagix.ExecuteTasks(c.ctx, task)
	if err != nil {
		return nil, err
	}

	if tbl != nil {
		for _, contact := range tbl.LSDeleteThenInsertContact {
			if contact.Id == opts.UserID {
				return &ContactInfo{
					ID:                contact.Id,
					Name:              contact.Name,
					FirstName:         contact.FirstName,
					Username:          contact.Username,
					ProfilePictureUrl: contact.GetAvatarURL(),
					IsMessengerUser:   contact.IsMessengerUser,
					Gender:            int64(contact.Gender),
					CanViewerMessage:  contact.CanViewerMessage,
				}, nil
			}
		}
	}

	return nil, fmt.Errorf("user not found: %d", opts.UserID)
}

// ==================== E2EE Media Functions ====================

// SendE2EEImageOptions for sending E2EE images
type SendE2EEImageOptions struct {
	ChatJID          string `json:"chatJid"`
	Data             []byte `json:"data"`
	MimeType         string `json:"mimeType"`
	Caption          string `json:"caption,omitempty"`
	Width            int    `json:"width,omitempty"`
	Height           int    `json:"height,omitempty"`
	ReplyToID        string `json:"replyToId,omitempty"`
	ReplyToSenderJID string `json:"replyToSenderJid,omitempty"`
}

// SendE2EEImage sends an E2EE image
func (c *Client) SendE2EEImage(opts *SendE2EEImageOptions) (*SendMessageResult, error) {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !e2eeClient.IsConnected() {
		return nil, ErrE2EENotConnected
	}

	chatJID, err := parseJID(opts.ChatJID)
	if err != nil {
		return nil, err
	}

	// Set default dimensions if not provided
	width := opts.Width
	height := opts.Height
	if width == 0 {
		width = 400
	}
	if height == 0 {
		height = 400
	}

	mimeType := opts.MimeType
	if mimeType == "" {
		mimeType = "image/jpeg"
	}

	// Upload media
	uploaded, err := e2eeClient.Upload(c.ctx, opts.Data, whatsmeow.MediaImage)
	if err != nil {
		return nil, err
	}

	// Build media transport (this is the proper way to send media in E2EE)
	mediaTransport := &waMediaTransport.WAMediaTransport{
		Integral: &waMediaTransport.WAMediaTransport_Integral{
			FileSHA256:        uploaded.FileSHA256,
			MediaKey:          uploaded.MediaKey,
			FileEncSHA256:     uploaded.FileEncSHA256,
			DirectPath:        &uploaded.DirectPath,
			MediaKeyTimestamp: proto.Int64(time.Now().Unix()),
		},
		Ancillary: &waMediaTransport.WAMediaTransport_Ancillary{
			FileLength: proto.Uint64(uint64(len(opts.Data))),
			Mimetype:   &mimeType,
			Thumbnail: &waMediaTransport.WAMediaTransport_Ancillary_Thumbnail{
				ThumbnailWidth:  proto.Uint32(uint32(width)),
				ThumbnailHeight: proto.Uint32(uint32(height)),
			},
			ObjectID: &uploaded.ObjectID,
		},
	}

	// Build image message with transport
	imageMsg := &waConsumerApplication.ConsumerApplication_ImageMessage{}
	if opts.Caption != "" {
		imageMsg.Caption = &waCommon.MessageText{Text: &opts.Caption}
	}

	// Set the transport using the proper method
	err = imageMsg.Set(&waMediaTransport.ImageTransport{
		Integral: &waMediaTransport.ImageTransport_Integral{
			Transport: mediaTransport,
		},
		Ancillary: &waMediaTransport.ImageTransport_Ancillary{
			Height: proto.Uint32(uint32(height)),
			Width:  proto.Uint32(uint32(width)),
		},
	})
	if err != nil {
		return nil, err
	}

	waMsg := &waConsumerApplication.ConsumerApplication{
		Payload: &waConsumerApplication.ConsumerApplication_Payload{
			Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{
				Content: &waConsumerApplication.ConsumerApplication_Content{
					Content: &waConsumerApplication.ConsumerApplication_Content_ImageMessage{
						ImageMessage: imageMsg,
					},
				},
			},
		},
	}

	// Build metadata for reply if specified
	var metadata *waMsgApplication.MessageApplication_Metadata
	if opts.ReplyToID != "" {
		metadata = &waMsgApplication.MessageApplication_Metadata{
			QuotedMessage: &waMsgApplication.MessageApplication_Metadata_QuotedMessage{
				StanzaID: &opts.ReplyToID,
			},
		}
		if opts.ReplyToSenderJID != "" {
			metadata.QuotedMessage.Participant = &opts.ReplyToSenderJID
		}
	}

	msgID := strconv.FormatInt(time.Now().UnixNano(), 10)
	resp, err := e2eeClient.SendFBMessage(c.ctx, chatJID, waMsg, metadata, whatsmeow.SendRequestExtra{
		ID:          msgID,
		MediaHandle: uploaded.Handle,
	})
	if err != nil {
		return nil, err
	}

	return &SendMessageResult{
		MessageID:   msgID,
		TimestampMs: resp.Timestamp.UnixMilli(),
	}, nil
}

// SendE2EEVideoOptions for sending E2EE videos
type SendE2EEVideoOptions struct {
	ChatJID          string `json:"chatJid"`
	Data             []byte `json:"data"`
	MimeType         string `json:"mimeType"`
	Caption          string `json:"caption,omitempty"`
	Width            int    `json:"width,omitempty"`
	Height           int    `json:"height,omitempty"`
	Duration         int    `json:"duration,omitempty"`
	ReplyToID        string `json:"replyToId,omitempty"`
	ReplyToSenderJID string `json:"replyToSenderJid,omitempty"`
}

// SendE2EEVideo sends an E2EE video
func (c *Client) SendE2EEVideo(opts *SendE2EEVideoOptions) (*SendMessageResult, error) {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !e2eeClient.IsConnected() {
		return nil, ErrE2EENotConnected
	}

	chatJID, err := parseJID(opts.ChatJID)
	if err != nil {
		return nil, err
	}

	// Set defaults
	width := opts.Width
	height := opts.Height
	if width == 0 {
		width = 400
	}
	if height == 0 {
		height = 400
	}
	mimeType := opts.MimeType
	if mimeType == "" {
		mimeType = "video/mp4"
	}

	// Upload media
	uploaded, err := e2eeClient.Upload(c.ctx, opts.Data, whatsmeow.MediaVideo)
	if err != nil {
		return nil, err
	}

	// Build media transport
	mediaTransport := &waMediaTransport.WAMediaTransport{
		Integral: &waMediaTransport.WAMediaTransport_Integral{
			FileSHA256:        uploaded.FileSHA256,
			MediaKey:          uploaded.MediaKey,
			FileEncSHA256:     uploaded.FileEncSHA256,
			DirectPath:        &uploaded.DirectPath,
			MediaKeyTimestamp: proto.Int64(time.Now().Unix()),
		},
		Ancillary: &waMediaTransport.WAMediaTransport_Ancillary{
			FileLength: proto.Uint64(uint64(len(opts.Data))),
			Mimetype:   &mimeType,
			Thumbnail: &waMediaTransport.WAMediaTransport_Ancillary_Thumbnail{
				ThumbnailWidth:  proto.Uint32(uint32(width)),
				ThumbnailHeight: proto.Uint32(uint32(height)),
			},
			ObjectID: &uploaded.ObjectID,
		},
	}

	// Build video message with transport
	videoMsg := &waConsumerApplication.ConsumerApplication_VideoMessage{}
	if opts.Caption != "" {
		videoMsg.Caption = &waCommon.MessageText{Text: &opts.Caption}
	}

	isGif := false
	err = videoMsg.Set(&waMediaTransport.VideoTransport{
		Integral: &waMediaTransport.VideoTransport_Integral{
			Transport: mediaTransport,
		},
		Ancillary: &waMediaTransport.VideoTransport_Ancillary{
			Height:      proto.Uint32(uint32(height)),
			Width:       proto.Uint32(uint32(width)),
			Seconds:     proto.Uint32(uint32(opts.Duration)),
			GifPlayback: &isGif,
		},
	})
	if err != nil {
		return nil, err
	}

	waMsg := &waConsumerApplication.ConsumerApplication{
		Payload: &waConsumerApplication.ConsumerApplication_Payload{
			Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{
				Content: &waConsumerApplication.ConsumerApplication_Content{
					Content: &waConsumerApplication.ConsumerApplication_Content_VideoMessage{
						VideoMessage: videoMsg,
					},
				},
			},
		},
	}

	// Build metadata for reply if specified
	var metadata *waMsgApplication.MessageApplication_Metadata
	if opts.ReplyToID != "" {
		metadata = &waMsgApplication.MessageApplication_Metadata{
			QuotedMessage: &waMsgApplication.MessageApplication_Metadata_QuotedMessage{
				StanzaID: &opts.ReplyToID,
			},
		}
		if opts.ReplyToSenderJID != "" {
			metadata.QuotedMessage.Participant = &opts.ReplyToSenderJID
		}
	}

	msgID := strconv.FormatInt(time.Now().UnixNano(), 10)
	resp, err := e2eeClient.SendFBMessage(c.ctx, chatJID, waMsg, metadata, whatsmeow.SendRequestExtra{
		ID:          msgID,
		MediaHandle: uploaded.Handle,
	})
	if err != nil {
		return nil, err
	}

	return &SendMessageResult{
		MessageID:   msgID,
		TimestampMs: resp.Timestamp.UnixMilli(),
	}, nil
}

// SendE2EEAudioOptions for sending E2EE audio/voice
type SendE2EEAudioOptions struct {
	ChatJID          string `json:"chatJid"`
	Data             []byte `json:"data"`
	MimeType         string `json:"mimeType"`
	Duration         int    `json:"duration,omitempty"`
	PTT              bool   `json:"ptt"` // Push-to-talk (voice message)
	ReplyToID        string `json:"replyToId,omitempty"`
	ReplyToSenderJID string `json:"replyToSenderJid,omitempty"`
}

// SendE2EEAudio sends an E2EE audio/voice message
func (c *Client) SendE2EEAudio(opts *SendE2EEAudioOptions) (*SendMessageResult, error) {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !e2eeClient.IsConnected() {
		return nil, ErrE2EENotConnected
	}

	chatJID, err := parseJID(opts.ChatJID)
	if err != nil {
		return nil, err
	}

	mimeType := opts.MimeType
	if mimeType == "" {
		mimeType = "audio/ogg; codecs=opus"
	}

	// Upload media
	uploaded, err := e2eeClient.Upload(c.ctx, opts.Data, whatsmeow.MediaAudio)
	if err != nil {
		return nil, err
	}

	// Build media transport
	mediaTransport := &waMediaTransport.WAMediaTransport{
		Integral: &waMediaTransport.WAMediaTransport_Integral{
			FileSHA256:        uploaded.FileSHA256,
			MediaKey:          uploaded.MediaKey,
			FileEncSHA256:     uploaded.FileEncSHA256,
			DirectPath:        &uploaded.DirectPath,
			MediaKeyTimestamp: proto.Int64(time.Now().Unix()),
		},
		Ancillary: &waMediaTransport.WAMediaTransport_Ancillary{
			FileLength: proto.Uint64(uint64(len(opts.Data))),
			Mimetype:   &mimeType,
			ObjectID:   &uploaded.ObjectID,
		},
	}

	// Build audio message with transport
	audioMsg := &waConsumerApplication.ConsumerApplication_AudioMessage{
		PTT: &opts.PTT,
	}
	err = audioMsg.Set(&waMediaTransport.AudioTransport{
		Integral: &waMediaTransport.AudioTransport_Integral{
			Transport: mediaTransport,
		},
		Ancillary: &waMediaTransport.AudioTransport_Ancillary{
			Seconds: proto.Uint32(uint32(opts.Duration)),
		},
	})
	if err != nil {
		return nil, err
	}

	waMsg := &waConsumerApplication.ConsumerApplication{
		Payload: &waConsumerApplication.ConsumerApplication_Payload{
			Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{
				Content: &waConsumerApplication.ConsumerApplication_Content{
					Content: &waConsumerApplication.ConsumerApplication_Content_AudioMessage{
						AudioMessage: audioMsg,
					},
				},
			},
		},
	}

	// Build metadata for reply if specified
	var metadata *waMsgApplication.MessageApplication_Metadata
	if opts.ReplyToID != "" {
		metadata = &waMsgApplication.MessageApplication_Metadata{
			QuotedMessage: &waMsgApplication.MessageApplication_Metadata_QuotedMessage{
				StanzaID: &opts.ReplyToID,
			},
		}
		if opts.ReplyToSenderJID != "" {
			metadata.QuotedMessage.Participant = &opts.ReplyToSenderJID
		}
	}

	msgID := strconv.FormatInt(time.Now().UnixNano(), 10)
	resp, err := e2eeClient.SendFBMessage(c.ctx, chatJID, waMsg, metadata, whatsmeow.SendRequestExtra{
		ID:          msgID,
		MediaHandle: uploaded.Handle,
	})
	if err != nil {
		return nil, err
	}

	return &SendMessageResult{
		MessageID:   msgID,
		TimestampMs: resp.Timestamp.UnixMilli(),
	}, nil
}

// SendE2EEDocumentOptions for sending E2EE documents/files
type SendE2EEDocumentOptions struct {
	ChatJID          string `json:"chatJid"`
	Data             []byte `json:"data"`
	Filename         string `json:"filename"`
	MimeType         string `json:"mimeType"`
	ReplyToID        string `json:"replyToId,omitempty"`
	ReplyToSenderJID string `json:"replyToSenderJid,omitempty"`
}

// SendE2EEDocument sends an E2EE document/file
func (c *Client) SendE2EEDocument(opts *SendE2EEDocumentOptions) (*SendMessageResult, error) {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !e2eeClient.IsConnected() {
		return nil, ErrE2EENotConnected
	}

	chatJID, err := parseJID(opts.ChatJID)
	if err != nil {
		return nil, err
	}

	mimeType := opts.MimeType
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	// Upload media
	uploaded, err := e2eeClient.Upload(c.ctx, opts.Data, whatsmeow.MediaDocument)
	if err != nil {
		return nil, err
	}

	// Build media transport
	mediaTransport := &waMediaTransport.WAMediaTransport{
		Integral: &waMediaTransport.WAMediaTransport_Integral{
			FileSHA256:        uploaded.FileSHA256,
			MediaKey:          uploaded.MediaKey,
			FileEncSHA256:     uploaded.FileEncSHA256,
			DirectPath:        &uploaded.DirectPath,
			MediaKeyTimestamp: proto.Int64(time.Now().Unix()),
		},
		Ancillary: &waMediaTransport.WAMediaTransport_Ancillary{
			FileLength: proto.Uint64(uint64(len(opts.Data))),
			Mimetype:   &mimeType,
			ObjectID:   &uploaded.ObjectID,
		},
	}

	// Build document message with transport
	docMsg := &waConsumerApplication.ConsumerApplication_DocumentMessage{
		FileName: &opts.Filename,
	}
	err = docMsg.Set(&waMediaTransport.DocumentTransport{
		Integral: &waMediaTransport.DocumentTransport_Integral{
			Transport: mediaTransport,
		},
		Ancillary: &waMediaTransport.DocumentTransport_Ancillary{},
	})
	if err != nil {
		return nil, err
	}

	waMsg := &waConsumerApplication.ConsumerApplication{
		Payload: &waConsumerApplication.ConsumerApplication_Payload{
			Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{
				Content: &waConsumerApplication.ConsumerApplication_Content{
					Content: &waConsumerApplication.ConsumerApplication_Content_DocumentMessage{
						DocumentMessage: docMsg,
					},
				},
			},
		},
	}

	// Build metadata for reply if specified
	var metadata *waMsgApplication.MessageApplication_Metadata
	if opts.ReplyToID != "" {
		metadata = &waMsgApplication.MessageApplication_Metadata{
			QuotedMessage: &waMsgApplication.MessageApplication_Metadata_QuotedMessage{
				StanzaID: &opts.ReplyToID,
			},
		}
		if opts.ReplyToSenderJID != "" {
			metadata.QuotedMessage.Participant = &opts.ReplyToSenderJID
		}
	}

	msgID := strconv.FormatInt(time.Now().UnixNano(), 10)
	resp, err := e2eeClient.SendFBMessage(c.ctx, chatJID, waMsg, metadata, whatsmeow.SendRequestExtra{
		ID:          msgID,
		MediaHandle: uploaded.Handle,
	})
	if err != nil {
		return nil, err
	}

	return &SendMessageResult{
		MessageID:   msgID,
		TimestampMs: resp.Timestamp.UnixMilli(),
	}, nil
}

// SendE2EEStickerOptions for sending E2EE stickers
type SendE2EEStickerOptions struct {
	ChatJID          string `json:"chatJid"`
	Data             []byte `json:"data"`
	MimeType         string `json:"mimeType"` // image/webp
	Width            int    `json:"width,omitempty"`
	Height           int    `json:"height,omitempty"`
	ReplyToID        string `json:"replyToId,omitempty"`
	ReplyToSenderJID string `json:"replyToSenderJid,omitempty"`
}

// SendE2EESticker sends an E2EE sticker
func (c *Client) SendE2EESticker(opts *SendE2EEStickerOptions) (*SendMessageResult, error) {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !e2eeClient.IsConnected() {
		return nil, ErrE2EENotConnected
	}

	chatJID, err := parseJID(opts.ChatJID)
	if err != nil {
		return nil, err
	}

	// Set defaults
	width := opts.Width
	height := opts.Height
	if width == 0 {
		width = 512
	}
	if height == 0 {
		height = 512
	}
	mimeType := opts.MimeType
	if mimeType == "" {
		mimeType = "image/webp"
	}

	// Upload media (stickers are typically image/webp)
	uploaded, err := e2eeClient.Upload(c.ctx, opts.Data, whatsmeow.MediaImage)
	if err != nil {
		return nil, err
	}

	// Build media transport
	mediaTransport := &waMediaTransport.WAMediaTransport{
		Integral: &waMediaTransport.WAMediaTransport_Integral{
			FileSHA256:        uploaded.FileSHA256,
			MediaKey:          uploaded.MediaKey,
			FileEncSHA256:     uploaded.FileEncSHA256,
			DirectPath:        &uploaded.DirectPath,
			MediaKeyTimestamp: proto.Int64(time.Now().Unix()),
		},
		Ancillary: &waMediaTransport.WAMediaTransport_Ancillary{
			FileLength: proto.Uint64(uint64(len(opts.Data))),
			Mimetype:   &mimeType,
			Thumbnail: &waMediaTransport.WAMediaTransport_Ancillary_Thumbnail{
				ThumbnailWidth:  proto.Uint32(uint32(width)),
				ThumbnailHeight: proto.Uint32(uint32(height)),
			},
			ObjectID: &uploaded.ObjectID,
		},
	}

	// Build sticker message with transport
	stickerMsg := &waConsumerApplication.ConsumerApplication_StickerMessage{}
	err = stickerMsg.Set(&waMediaTransport.StickerTransport{
		Integral: &waMediaTransport.StickerTransport_Integral{
			Transport: mediaTransport,
		},
		Ancillary: &waMediaTransport.StickerTransport_Ancillary{
			Height: proto.Uint32(uint32(height)),
			Width:  proto.Uint32(uint32(width)),
		},
	})
	if err != nil {
		return nil, err
	}

	waMsg := &waConsumerApplication.ConsumerApplication{
		Payload: &waConsumerApplication.ConsumerApplication_Payload{
			Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{
				Content: &waConsumerApplication.ConsumerApplication_Content{
					Content: &waConsumerApplication.ConsumerApplication_Content_StickerMessage{
						StickerMessage: stickerMsg,
					},
				},
			},
		},
	}

	// Build metadata for reply if specified
	var metadata *waMsgApplication.MessageApplication_Metadata
	if opts.ReplyToID != "" {
		metadata = &waMsgApplication.MessageApplication_Metadata{
			QuotedMessage: &waMsgApplication.MessageApplication_Metadata_QuotedMessage{
				StanzaID: &opts.ReplyToID,
			},
		}
		if opts.ReplyToSenderJID != "" {
			metadata.QuotedMessage.Participant = &opts.ReplyToSenderJID
		}
	}

	msgID := strconv.FormatInt(time.Now().UnixNano(), 10)
	resp, err := e2eeClient.SendFBMessage(c.ctx, chatJID, waMsg, metadata, whatsmeow.SendRequestExtra{
		ID:          msgID,
		MediaHandle: uploaded.Handle,
	})
	if err != nil {
		return nil, err
	}

	return &SendMessageResult{
		MessageID:   msgID,
		TimestampMs: resp.Timestamp.UnixMilli(),
	}, nil
}

// DownloadE2EEMediaOptions for downloading E2EE media
type DownloadE2EEMediaOptions struct {
	DirectPath     string `json:"directPath"`
	MediaKey       string `json:"mediaKey"`       // base64 encoded
	MediaSHA256    string `json:"mediaSha256"`    // base64 encoded
	MediaEncSHA256 string `json:"mediaEncSha256"` // base64 encoded - encrypted file SHA256
	MediaType      string `json:"mediaType"`      // "image", "video", "audio", "document", "sticker"
	MimeType       string `json:"mimeType"`
	FileSize       int64  `json:"fileSize"`
}

// DownloadE2EEMediaResult result of downloading E2EE media
type DownloadE2EEMediaResult struct {
	Data     []byte `json:"data"`
	MimeType string `json:"mimeType"`
	FileSize int64  `json:"fileSize"`
}

// DownloadE2EEMedia downloads and decrypts E2EE media
func (c *Client) DownloadE2EEMedia(opts *DownloadE2EEMediaOptions) (*DownloadE2EEMediaResult, error) {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !e2eeClient.IsConnected() {
		return nil, ErrE2EENotConnected
	}

	// Decode base64 keys
	mediaKey, err := decodeBase64(opts.MediaKey)
	if err != nil {
		return nil, fmt.Errorf("failed to decode mediaKey: %w", err)
	}
	mediaSHA256, err := decodeBase64(opts.MediaSHA256)
	if err != nil {
		return nil, fmt.Errorf("failed to decode mediaSha256: %w", err)
	}
	var mediaEncSHA256 []byte
	if opts.MediaEncSHA256 != "" {
		mediaEncSHA256, err = decodeBase64(opts.MediaEncSHA256)
		if err != nil {
			return nil, fmt.Errorf("failed to decode mediaEncSha256: %w", err)
		}
	}

	// Map media type string to whatsmeow.MediaType
	var waMediaType whatsmeow.MediaType
	switch opts.MediaType {
	case "image":
		waMediaType = whatsmeow.MediaImage
	case "video":
		waMediaType = whatsmeow.MediaVideo
	case "audio", "voice":
		waMediaType = whatsmeow.MediaAudio
	case "document", "file":
		waMediaType = whatsmeow.MediaDocument
	case "sticker":
		waMediaType = whatsmeow.MediaImage // Stickers use image type
	default:
		waMediaType = whatsmeow.MediaDocument
	}

	// Create WAMediaTransport Integral for download
	directPath := opts.DirectPath
	integral := &waMediaTransport.WAMediaTransport_Integral{
		MediaKey:      mediaKey,
		FileSHA256:    mediaSHA256,
		FileEncSHA256: mediaEncSHA256,
		DirectPath:    &directPath,
	}

	// Download and decrypt
	data, err := e2eeClient.DownloadFB(c.ctx, integral, waMediaType)
	if err != nil {
		return nil, fmt.Errorf("failed to download E2EE media: %w", err)
	}

	return &DownloadE2EEMediaResult{
		Data:     data,
		MimeType: opts.MimeType,
		FileSize: int64(len(data)),
	}, nil
}

// decodeBase64 decodes a base64 string
func decodeBase64(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

// Unused imports fix
var _ = context.Background
var _ = messagix.NewClient
