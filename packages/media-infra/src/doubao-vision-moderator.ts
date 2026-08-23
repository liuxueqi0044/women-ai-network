import type { MediaContentModerationResult, MediaContentModeratorPort } from '@wai/contracts';
import { MEDIA_CONTENT_REASON_CODES } from '@wai/contracts';
import { z } from 'zod';

const decisionSchema = z
  .object({
    decision: z.enum(['allow', 'block', 'review']),
    reason_codes: z.array(z.enum(MEDIA_CONTENT_REASON_CODES)).max(9),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === 'allow' && value.reason_codes.length !== 0) {
      context.addIssue({ code: 'custom', message: 'allow must not include reasons' });
    }
    if (value.decision !== 'allow' && value.reason_codes.length === 0) {
      context.addIssue({ code: 'custom', message: 'non-allow decisions require a reason' });
    }
  });

const responseSchema = z
  .object({
    model: z.string().min(1).max(200),
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string().min(1).max(2_000) }).passthrough(),
          })
          .passthrough(),
      )
      .min(1)
      .max(1),
  })
  .passthrough();

const SYSTEM_PROMPT = `You are a narrow image content-safety classifier for profile avatars and
profile gallery images. Return exactly one JSON object and no markdown or prose:
{"decision":"allow|block|review","reason_codes":["CLOSED_CODE"]}

Allowed reason codes: SEXUAL_CONTENT, SEXUALIZED_MINOR, GRAPHIC_VIOLENCE,
SELF_HARM, HATE_OR_EXTREMISM, ILLEGAL_GOODS, PERSONAL_DOCUMENT,
CONTACT_OR_QR_SPAM, OTHER_UNSAFE_CONTENT.

Block clear policy violations. Use review only when the image cannot be safely classified.
Never infer or report identity, gender, age, ethnicity, nationality, health, disability,
religion, sexual orientation, attractiveness, relationship intent or membership eligibility.
Do not transcribe private text. Do not describe the image. Do not identify a person.`;

export interface DoubaoVisionModeratorConfig {
  readonly apiBaseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Volcengine Ark ChatCompletions visual adapter with a closed, fail-closed result. */
export class DoubaoVisionModerator implements MediaContentModeratorPort {
  constructor(
    private readonly config: DoubaoVisionModeratorConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async review(
    input: Parameters<MediaContentModeratorPort['review']>[0],
  ): Promise<MediaContentModerationResult> {
    try {
      const response = await this.fetcher(
        `${this.config.apiBaseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.model,
            stream: false,
            temperature: 0,
            max_tokens: 160,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: SYSTEM_PROMPT },
                  { type: 'image_url', image_url: { url: input.contentUrl } },
                ],
              },
            ],
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(input.timeoutMs),
        },
      );
      if (!response.ok) return { decision: 'unavailable', reasonCodes: [] };
      const envelope = responseSchema.safeParse(await response.json());
      if (!envelope.success) return { decision: 'unavailable', reasonCodes: [] };
      const raw = envelope.data.choices[0]?.message.content;
      if (raw === undefined) return { decision: 'unavailable', reasonCodes: [] };
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return { decision: 'unavailable', reasonCodes: [] };
      }
      const decision = decisionSchema.safeParse(value);
      if (!decision.success) return { decision: 'unavailable', reasonCodes: [] };
      return {
        decision: decision.data.decision,
        reasonCodes: decision.data.reason_codes,
        providerVersion: envelope.data.model,
      };
    } catch {
      return { decision: 'unavailable', reasonCodes: [] };
    }
  }
}

/** Explicit test/dev adapter. Production composition must reject it. */
export class AllowAllMediaContentModerator implements MediaContentModeratorPort {
  async review(): Promise<MediaContentModerationResult> {
    return { decision: 'allow', reasonCodes: [], providerVersion: 'test-only' };
  }
}
