// Vikunja is a to-do list application to facilitate your life.
// Copyright 2018-present Vikunja and contributors. All rights reserved.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package apiv2

import (
	"context"
	"errors"
	"net/http"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(registerNoteOrganizationRoutes) }

type noteOrganizationResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         tcyai.NoteOrganizationActivity
}

func noteOrganizationStartError(ctx context.Context, err error) error {
	var capacity tcyai.NoteOrganizationCapacityError
	if errors.As(err, &capacity) {
		return huma.ErrorWithHeaders(huma.Error429TooManyRequests(capacity.Error()), http.Header{
			"Retry-After": {"5"},
		})
	}
	return aiError(ctx, err)
}

func registerNoteOrganizationRoutes(api huma.API) {
	Register(api, asterNotesOperation(huma.Operation{
		OperationID: "note-organization-read",
		Method:      http.MethodGet,
		Path:        "/notes/{id}/organization",
		Tags:        []string{"notes"},
		Summary:     "Read this note's latest organization job",
		Description: "Owner-only. Observes existing progress without starting model work; an interrupted process requires explicit retry.",
	}), readNoteOrganization)
	Register(api, asterNotesOperation(huma.Operation{
		OperationID: "note-organization-create",
		Method:      http.MethodPost,
		Path:        "/notes/{id}/organization",
		Tags:        []string{"notes"},
		Summary:     "Organize a saved article or original transcript with a selected model",
		Description: "Creates a resumable background job, mapping bounded source slices and hierarchically merging them. Does not grant Arona tools, edit original text, or automatically adopt its result.",
	}), createNoteOrganization)
	Register(api, asterNotesOperation(huma.Operation{
		OperationID: "note-organization-control",
		Method:      http.MethodPost,
		Path:        "/notes/{id}/organization/{job_id}/control",
		Tags:        []string{"notes"},
		Summary:     "Cancel or explicitly retry a note organization job",
		Description: "Retry resumes completed checkpoints and only repeats an unfinished model request. A new authorized human session is required.",
	}), controlNoteOrganization)
	Register(api, asterNotesOperation(huma.Operation{
		OperationID: "note-organization-apply",
		Method:      http.MethodPost,
		Path:        "/notes/{id}/organization/{job_id}/apply",
		Tags:        []string{"notes"},
		Summary:     "Explicitly adopt a completed organization preview",
		Description: "Append or replace only when expected_revision matches. Raw transcript remains immutable. Unsaved local drafts must be saved or resolved by the UI before applying.",
	}), applyNoteOrganization)
}
func readNoteOrganization(ctx context.Context, in *struct {
	ID int64 `path:"id" minimum:"1"`
}) (*noteOrganizationResponse, error) {
	a, err := asterNotesAuth(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewReadSession()
	db.SetSessionContext(ctx, s)
	job, err := models.ReadAsterNoteOrganization(s, a, in.ID, 0)
	_ = s.Close()
	if err != nil {
		return nil, translateDomainError(err)
	}
	activity, err := tcyai.NoteOrganizationStatus(ctx, a.(*user.User), job)
	if err != nil {
		return nil, translateDomainError(err)
	}
	return &noteOrganizationResponse{
		CacheControl: "no-store",
		Body:         activity,
	}, nil
}
func createNoteOrganization(ctx context.Context, in *struct {
	ID   int64 `path:"id" minimum:"1"`
	Body struct {
		Source       string `json:"source" enum:"transcript,article" default:"transcript" doc:"Original transcript or snapshot of the currently saved article."`
		ConnectionID string `json:"connection_id,omitempty" maxLength:"80" doc:"This account's text-model connection; empty uses its transcript-cleanup model or assistant."`
	}
}) (*noteOrganizationResponse, error) {
	a, err := asterNotesAuth(ctx)
	if err != nil {
		return nil, err
	}
	actor := a.(*user.User)
	ctx = tcyai.WithAccountRunAdmission(ctx, actor.ID)
	settings, err := tcyai.Load(actor.ID)
	if err != nil {
		return nil, aiError(ctx, err)
	}
	id := in.Body.ConnectionID
	if id == "" {
		id = settings.Cleanup
	}
	if id == "" {
		id = settings.Assistant
	}
	c, err := settings.Find(id, "chat")
	if err != nil {
		return nil, aiError(ctx, err)
	}
	reservation, err := tcyai.ReserveNoteOrganizationStart(ctx, actor.ID)
	if err != nil {
		return nil, noteOrganizationStartError(ctx, err)
	}
	defer reservation.Abort()
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	job, err := models.CreateAsterNoteOrganization(s, a, in.ID, in.Body.Source, c.ID, c.Model)
	if err != nil {
		return nil, translateDomainError(err)
	}
	if err = s.Commit(); err != nil {
		return nil, translateDomainError(err)
	}
	if err = tcyai.StartNoteOrganization(ctx, actor, job, c, reservation); err != nil {
		return nil, noteOrganizationStartError(ctx, err)
	}
	return &noteOrganizationResponse{
		CacheControl: "no-store",
		Body:         tcyai.NoteOrganizationActivity{Job: job},
	}, nil
}
func controlNoteOrganization(ctx context.Context, in *struct {
	ID    int64 `path:"id" minimum:"1"`
	JobID int64 `path:"job_id" minimum:"1"`
	Body  struct {
		Action string `json:"action" enum:"cancel,retry,discard" doc:"Cancel an active attempt, explicitly resume a saved checkpoint, or discard a terminal preview and checkpoints without touching the article or raw transcript."`
	}
}) (*noteOrganizationResponse, error) {
	a, err := asterNotesAuth(ctx)
	if err != nil {
		return nil, err
	}
	actor := a.(*user.User)
	ctx = tcyai.WithAccountRunAdmission(ctx, actor.ID)
	var reservation *tcyai.NoteOrganizationReservation
	if in.Body.Action == "retry" {
		reservation, err = tcyai.ReserveNoteOrganizationStart(ctx, actor.ID)
		if err != nil {
			return nil, noteOrganizationStartError(ctx, err)
		}
		defer reservation.Abort()
	}
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	job, err := models.ChangeAsterNoteOrganization(s, a, in.ID, in.JobID, in.Body.Action)
	if err != nil {
		return nil, translateDomainError(err)
	}
	var c tcyai.Connection
	if in.Body.Action == "retry" {
		settings, loadErr := tcyai.Load(actor.ID)
		if loadErr != nil {
			return nil, aiError(ctx, loadErr)
		}
		c, err = settings.Find(job.ConnectionID, "chat")
		if err != nil {
			return nil, aiError(ctx, err)
		}
	}
	if err = s.Commit(); err != nil {
		return nil, translateDomainError(err)
	}
	if job == nil {
		return &noteOrganizationResponse{
			CacheControl: "no-store",
			Body:         tcyai.NoteOrganizationActivity{},
		}, nil
	}
	if in.Body.Action == "cancel" {
		tcyai.CancelNoteOrganization(actor.ID, job.ID, job.Attempt)
	} else if err = tcyai.StartNoteOrganization(ctx, actor, job, c, reservation); err != nil {
		return nil, noteOrganizationStartError(ctx, err)
	}
	return &noteOrganizationResponse{
		CacheControl: "no-store",
		Body:         tcyai.NoteOrganizationActivity{Job: job},
	}, nil
}
func applyNoteOrganization(ctx context.Context, in *struct {
	ID    int64 `path:"id" minimum:"1"`
	JobID int64 `path:"job_id" minimum:"1"`
	Body  struct {
		ExpectedRevision int64  `json:"expected_revision" minimum:"1" doc:"Current saved article revision explicitly reviewed by the user."`
		Mode             string `json:"mode" enum:"append,replace" doc:"Append below existing saved text or explicitly replace it. Original transcript is always retained."`
	}
}) (*asterNoteResponse, error) {
	a, err := asterNotesAuth(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	note, err := models.ApplyAsterNoteOrganization(s, a, in.ID, in.JobID, in.Body.ExpectedRevision, in.Body.Mode)
	if err != nil {
		return nil, translateDomainError(err)
	}
	if err = s.Commit(); err != nil {
		return nil, translateDomainError(err)
	}
	return &asterNoteResponse{
		CacheControl: "no-store",
		Body:         note,
	}, nil
}
