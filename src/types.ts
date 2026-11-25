/**
 * Shapes of the Lystok API v1, as the API sends and takes them (snake_case keys).
 * Reference: https://api.lystok.com/docs
 */

/** Interface languages; a template may have a version in each. */
export type Locale = 'uk' | 'en' | 'pl' | 'de' | 'es' | 'fr' | 'ru'

export interface Attachment {
  /** The name the recipient sees. */
  filename: string
  /** The file, base64-encoded. */
  content: string
  /** MIME type; guessed from the file name when missing. */
  content_type?: string
}

/** One email. Give either `html` (and `subject`) or `template_id`. */
export interface SendEmailParams {
  /** Sender: an address on a verified domain of your account, with an optional name. */
  from: string
  /** One recipient address. */
  to: string
  /** Required without `template_id`; with a template it replaces the template's subject. */
  subject?: string
  html?: string
  /** Plain-text version. Made from `html` when not given. */
  text?: string
  /** A template from your account (Templates → ⋯ → Copy ID). */
  template_id?: string
  /** Values for the template's {{ variables }}. */
  data?: Record<string, unknown>
  /** Which language version of the template to use. */
  locale?: Locale
  reply_to?: string
  /** Extra headers: X-*, List-Unsubscribe, List-Unsubscribe-Post, References, In-Reply-To. */
  headers?: Record<string, string>
  /** Up to 10 key/value pairs to find the email by later. */
  tags?: Record<string, string>
  /** Count opens and clicks. Off by default. */
  tracking?: { opens?: boolean, clicks?: boolean }
  /** Up to 10 files, 7 MB together (before base64). */
  attachments?: Attachment[]
}

export interface EmailCreated {
  id: string
}

export interface EmailBatchCreated {
  data: EmailCreated[]
}

export type EmailState = 'queued' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed'

export interface Email {
  id: string
  from: string
  to: string
  subject: string
  template_id: string | null
  /** queued → sent → delivered; or bounced, complained, failed, suppressed. */
  state: EmailState
  /** Why it failed or was suppressed. */
  error: string | null
  tags: Record<string, string>
  created_at: string
  sent_at: string | null
  delivered_at: string | null
  bounced_at: string | null
  complained_at: string | null
  opened_at: string | null
  clicked_at: string | null
}

export type ContactStatus = 'subscribed' | 'unsubscribed' | 'bounced' | 'complained'
export type FieldValue = string | number | boolean

export interface Contact {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  locale: string | null
  status: ContactStatus
  fields: Record<string, FieldValue>
  lists: string[]
  tags: string[]
  /** How the contact was added: manual, import, api, form. */
  source: string
  consent_source: string | null
  consent_at: string | null
  created_at: string
  updated_at: string
}

/** Adds a person, or updates them when the address is already there. */
export interface UpsertContactParams {
  email: string
  first_name?: string
  last_name?: string
  phone?: string
  locale?: Locale | null
  /** Your own fields by key; `null` removes a value. */
  fields?: Record<string, FieldValue | null>
  /** Add to these lists, by name. The lists must exist. */
  lists?: string[]
  /** Add these tags, by name. New tags are created. */
  tags?: string[]
  /** How the person agreed to get your emails. Required for a new contact. */
  consent_source?: string
}

export interface UpdateContactParams extends Partial<UpsertContactParams> {
  /** Take out of these lists, by name. */
  remove_lists?: string[]
  /** Remove these tags, by name. */
  remove_tags?: string[]
  /** Unsubscribe the person from your newsletters (transactional email still reaches them). */
  status?: 'unsubscribed'
}

export type WebhookEventType =
  | 'email.sent'
  | 'email.delivered'
  | 'email.bounced'
  | 'email.complained'
  | 'email.failed'
  | 'email.suppressed'
  | 'email.opened'
  | 'email.clicked'
  | 'contact.unsubscribed'

/** What a webhook brings. `data` depends on `type`; see the API reference. */
export interface WebhookEvent {
  type: WebhookEventType
  created_at: string
  data: Record<string, unknown>
}
