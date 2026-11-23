import { describe, expect, it } from 'vitest'
import {
  buildMuseApprovalDecideParams,
  extractApprovalMetadata,
  extractRawApprovalItems,
  isUploadApproval,
  mapMuseApproval,
  resolveApprovalOptions
} from './museApprovals'

describe('museApprovals', () => {
  it('extracts pending_approvals even when legacy pending is an empty array', () => {
    const raw = {
      pending: [],
      pending_approvals: [
        {
          approval_id: 'appr_upload_1',
          status: 'pending',
          approval_type: 'outgoing_media',
          decision_options: [
            { kind: 'allow_once', label: { kind: 'allow_once' }, label_text: '允许一次', opens_url: null },
            {
              kind: 'allow_always',
              label: { kind: 'allow_always_scoped', scope: 'destination_domain' },
              label_text: '始终允许上传到此站点',
              opens_url: null
            },
            { kind: 'deny', label: { kind: 'deny' }, label_text: '拒绝', opens_url: null }
          ],
          display: {
            display_name: 'Browser',
            action_description:
              'Your assistant wants to upload a file to github.com to post the comment on GitHub issue #41.',
            permission_question: {
              kind: 'outgoing_media',
              text: '允许Muse使用 Browser 上传这个文件?'
            }
          },
          payload: {
            type: 'outgoing_media',
            outgoing_media_payload: {
              destination_domain: 'github.com',
              filename: 'screenshot.png'
            }
          }
        },
        {
          approval_id: 'appr_done_2',
          status: 'approved',
          approval_type: 'network'
        }
      ]
    }

    const items = extractRawApprovalItems(raw)
    expect(items).toHaveLength(1)
    expect(items[0]!['approval_id']).toBe('appr_upload_1')

    const mapped = mapMuseApproval(items[0]!)
    expect(mapped.id).toBe('appr_upload_1')
    expect(mapped.title).toBe('允许Muse使用 Browser 上传这个文件?')
    expect(mapped.hasExplicitTitle).toBe(true)
    expect(mapped.detail).toContain('github.com')
    expect(mapped.host).toBe('github.com')
    expect(isUploadApproval(mapped)).toBe(true)
    expect(mapped.decisionOptions).toEqual(['allow_once', 'allow_always', 'deny'])
    expect(mapped.decisionOptionDetails).toEqual([
      { kind: 'allow_once', label: '允许一次', labelKind: 'allow_once' },
      {
        kind: 'allow_always',
        label: '始终允许上传到此站点',
        labelKind: 'allow_always_scoped',
        scope: 'destination_domain'
      },
      { kind: 'deny', label: '拒绝', labelKind: 'deny' }
    ])

    const meta = extractApprovalMetadata(mapped)
    expect(meta.serviceName).toBe('Browser')
    expect(meta.filename).toBe('screenshot.png')
    expect(meta.editableMessage).toBe(false)
  })

  it('preserves connector_all_actions / deny_always scopes, multiple always scopes, and expected_message_revision', () => {
    const mapped = mapMuseApproval({
      approval_id: 'appr_conn_1',
      status: 'pending',
      approval_type: 'connector',
      editable_message_available: true,
      message_revision: 3,
      decision_options: [
        { kind: 'allow_once', label: { kind: 'allow_once' }, label_text: '' },
        {
          kind: 'allow_always',
          label: { kind: 'allow_always_scoped', scope: 'destination_domain' },
          label_text: ''
        },
        {
          kind: 'allow_always',
          label: { kind: 'allow_always_scoped', scope: 'connector_all_actions' },
          label_text: ''
        },
        {
          kind: 'deny_always',
          label: { kind: 'deny_always_scoped', scope: 'entity' },
          label_text: ''
        }
      ],
      display: {
        display_name: 'GitHub',
        action_description: 'Create issue comment',
        permission_question: { text: 'Allow Muse to use GitHub?' }
      },
      payload: {
        type: 'connector',
        connector_payload: {
          host: 'api.github.com',
          method: 'POST',
          path: '/repos/qybaihe/botark/issues/41/comments',
          scheme: 'https',
          payload_preview: { body: 'hello' }
        }
      }
    })

    expect(resolveApprovalOptions(mapped)).toHaveLength(4)

    const allowDomain = buildMuseApprovalDecideParams(mapped, mapped.id, 'allow_always', 'destination_domain')
    expect(allowDomain).toMatchObject({
      approval_id: 'appr_conn_1',
      decision: 'allow_always',
      always_scope: 'destination_domain',
      allow_always_scope: 'destination_domain',
      notification_channel: 'ui',
      expected_message_revision: 3
    })

    const allowConnector = buildMuseApprovalDecideParams(mapped, mapped.id, 'allow_always', 'connector_all_actions')
    expect(allowConnector).toMatchObject({
      approval_id: 'appr_conn_1',
      decision: 'allow_always',
      always_scope: 'connector_all_actions',
      allow_always_scope: 'connector_all_actions',
      notification_channel: 'ui',
      expected_message_revision: 3
    })

    const denyAlways = buildMuseApprovalDecideParams(mapped, mapped.id, 'deny_always')
    expect(denyAlways).toMatchObject({
      approval_id: 'appr_conn_1',
      decision: 'deny_always',
      always_scope: 'entity',
      expected_message_revision: 3
    })
    expect(denyAlways['allow_always_scope']).toBeUndefined()

    const meta = extractApprovalMetadata(mapped)
    expect(meta.method).toBe('POST')
    expect(meta.path).toBe('/repos/qybaihe/botark/issues/41/comments')
    expect(meta.editableMessage).toBe(true)
    expect(meta.preview).toEqual({ body: 'hello' })
  })

  it('detects nested space_reader_grant_eligible and falls back to entity-scoped allow_always/deny_always when options omitted', () => {
    const mapped = mapMuseApproval({
      approval_id: 'appr_space_1',
      status: 'pending',
      approval_type: 'connector',
      payload: {
        type: 'connector',
        connector_payload: {
          host: 'muse.ai',
          space_reader_grant_eligible: true
        }
      }
    })

    expect(resolveApprovalOptions(mapped)).toEqual([
      { kind: 'allow_always', scope: 'entity' },
      { kind: 'deny_always', scope: 'entity' }
    ])

    const params = buildMuseApprovalDecideParams(mapped, mapped.id, 'allow_always')
    expect(params['always_scope']).toBe('entity')
    expect(params['allow_always_scope']).toBe('entity')
  })
})
