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

package richtext

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

//nolint:gosmopolitan // Verify that multilingual user content is preserved byte for byte.
func TestFilterAttachmentImages(t *testing.T) {
	for _, tag := range []string{
		`<img data-src="https://task.test/api/v2/tasks/7/attachments/5" src="#">`,
		`<img src='/api/v1/tasks/7/attachments/5/preview?size=medium' alt='a > b'/>`,
		`<IMG src="/tasks/7/attachments/5">`,
	} {
		source := `<p>保留 &amp; text</p>` + tag + `<a href="/api/v2/tasks/7/attachments/5">link</a>`
		assert.Equal(t, `<p>保留 &amp; text</p><a href="/api/v2/tasks/7/attachments/5">link</a>`, FilterAttachmentImages(source, "https://task.test", func(tid, aid int64) bool { return tid == 7 && aid == 5 }))
	}
	for _, source := range []string{
		`<img src="https://other.test/api/v2/tasks/7/attachments/5">`,
		`<img src="https://evil@task.test/api/v2/tasks/7/attachments/5">`,
		`<img src="/api/v2/tasks/7/attachments/50">`,
		`<img src="/api/v2/tasks/8/attachments/5">`,
		`<img data-src="https://other.test/image" src="/api/v2/tasks/7/attachments/5">`,
		`<p>文字 &amp; 空格</p><!-- keep --><img src="data:image/png;base64,AA==">`,
	} {
		assert.Equal(t, source, FilterAttachmentImages(source, "https://task.test", func(tid, aid int64) bool { return tid == 7 && aid == 5 }))
	}
	assert.Empty(t, FilterAttachmentImages(`<img src="https://task.test/sub/api/v2/tasks/7/attachments/5">`, "https://task.test/sub/", func(_, _ int64) bool { return true }))
}

func TestFilterAttachmentImagesSplitOrigins(t *testing.T) {
	const frontend = "https://front.test/app/"
	const api = "https://api.test:8443/backend/api/v2/"
	for _, src := range []string{
		"https://api.test:8443/backend/api/v2/tasks/7/attachments/5",
		"https://API.TEST:8443/backend/api/v1/tasks/7/attachments/5/preview?size=medium",
		"//api.test:8443/backend/api/v2/tasks/7/attachments/5",
		"https://front.test:443/app/api/v2/tasks/7/attachments/5",
		"/backend/api/v2/tasks/7/attachments/5",
		"/api/v2/tasks/7/attachments/5",
		"/tasks/7/attachments/5",
	} {
		t.Run(src, func(t *testing.T) {
			image := `<img data-src="` + src + `" src="#">`
			assert.Equal(t, "<p>keep</p>", FilterAttachmentImages("<p>keep</p>"+image, frontend, func(tid, aid int64) bool { return tid == 7 && aid == 5 }, api))
		})
	}
	for _, src := range []string{
		"https://api.test:8444/backend/api/v2/tasks/7/attachments/5",
		"http://api.test:8443/backend/api/v2/tasks/7/attachments/5",
		"https://api.test/backend/api/v2/tasks/7/attachments/5",
		"https://api.test.evil:8443/backend/api/v2/tasks/7/attachments/5",
		"https://evil@api.test:8443/backend/api/v2/tasks/7/attachments/5",
		"https://api.test:8443/app/api/v2/tasks/7/attachments/5",
		"https://front.test/backend/api/v2/tasks/7/attachments/5",
		"https://api.test:8443/backend-evil/api/v2/tasks/7/attachments/5",
		"https://api.test:8443/api/v2/tasks/7/attachments/5",
		"https://api.test:8443/backend/api/v2/tasks/8/attachments/5",
		"https://api.test:8443/backend/api/v2/tasks/7/attachments/50",
		"https://api.test:8443/backend%2Fapi/v2/tasks/7/attachments/5",
		"ftp://api.test:8443/backend/api/v2/tasks/7/attachments/5",
	} {
		t.Run("preserve "+src, func(t *testing.T) {
			image := `<img data-src="` + src + `" src="/api/v2/tasks/7/attachments/5">`
			assert.Equal(t, image, FilterAttachmentImages(image, frontend, func(tid, aid int64) bool { return tid == 7 && aid == 5 }, api))
		})
	}
	// A frontend path named api/v2 is a deployment prefix, not an API suffix.
	assert.Empty(t, FilterAttachmentImages(`<img src="https://front.test/api/v2/api/v2/tasks/7/attachments/5">`, "https://front.test/api/v2/", func(_, _ int64) bool { return true }))
}

func TestFilterAttachmentImagesProtocolRelativeOrigin(t *testing.T) {
	image := `<img data-src="//api.test/backend/api/v2/tasks/7/attachments/5" src="#">`
	remove := func(tid, aid int64) bool { return tid == 7 && aid == 5 }
	assert.Equal(t, image, FilterAttachmentImages(image, "http://front.test/app/", remove, "https://api.test/backend/"), "protocol-relative image inherits HTTP from its frontend document")
	assert.Empty(t, FilterAttachmentImages(image, "http://front.test/app/", remove, "http://api.test/backend/"))
	assert.Equal(t, image, FilterAttachmentImages(image, "", remove, "https://api.test/backend/"), "unknown document scheme must not manufacture a trusted origin")
}

func TestRewriteAttachmentImagesKeepsUnrelatedContentAndOriginBoundary(t *testing.T) {
	source := `<p>before &amp; after</p><img src="/api/v2/tasks/7/attachments/5/preview?size=md" alt="a > b" data-src="/api/v2/tasks/7/attachments/5"><a href="/api/v2/tasks/7/attachments/5">original link</a><img src="https://foreign.test/api/v2/tasks/7/attachments/5"><img src="/api/v2/tasks/8/attachments/6">`
	actual := RewriteAttachmentImages(source, "https://task.test", func(taskID, attachmentID int64) string {
		if taskID == 7 && attachmentID == 5 {
			return "/api/v2/tasks/70/attachments/50"
		}
		return ""
	})
	assert.Contains(t, actual, `src="/api/v2/tasks/70/attachments/50"`)
	assert.Contains(t, actual, `alt="a &gt; b"`)
	assert.NotContains(t, actual, `data-src=`)
	assert.Contains(t, actual, `<p>before &amp; after</p>`)
	assert.Contains(t, actual, `<a href="/api/v2/tasks/7/attachments/5">original link</a>`)
	assert.Contains(t, actual, `<img src="https://foreign.test/api/v2/tasks/7/attachments/5">`)
	assert.Contains(t, actual, `<img src="/api/v2/tasks/8/attachments/6">`)
}
