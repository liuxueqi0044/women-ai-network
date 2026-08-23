import { describe, expect, it, vi } from 'vitest';
import { DoubaoVisionModerator } from './doubao-vision-moderator.js';

const input = {
  purpose: 'profile_avatar' as const,
  contentType: 'image/jpeg' as const,
  contentUrl: 'https://private.example/signed-object?opaque=1',
  timeoutMs: 1_000,
};

describe('DoubaoVisionModerator', () => {
  it('uses the Ark visual ChatCompletions contract and accepts only closed JSON', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ content: Array<Record<string, unknown>> }>;
      };
      expect(body.model).toBe('ep-vision-test');
      expect(body.messages[0]?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'image_url',
            image_url: { url: input.contentUrl },
          }),
        ]),
      );
      const prompt = JSON.stringify(body.messages);
      expect(prompt).toContain('Never infer');
      expect(prompt).toContain('gender');
      expect(prompt).toContain('identity');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"decision":"block","reason_codes":["PERSONAL_DOCUMENT"]}',
              },
            },
          ],
          model: 'doubao-vision-test-version',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const moderator = new DoubaoVisionModerator(
      {
        apiBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: 'not-a-real-secret',
        model: 'ep-vision-test',
      },
      fetcher,
    );

    await expect(moderator.review(input)).resolves.toEqual({
      decision: 'block',
      reasonCodes: ['PERSONAL_DOCUMENT'],
      providerVersion: 'doubao-vision-test-version',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer not-a-real-secret',
    );
  });

  it.each([
    ['non-2xx', new Response('{}', { status: 429 })],
    [
      'unknown reason',
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"decision":"allow","reason_codes":["BEAUTY_SCORE"]}' } },
          ],
          model: 'x',
        }),
        { status: 200 },
      ),
    ],
    [
      'prose',
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'looks okay' } }], model: 'x' }),
        { status: 200 },
      ),
    ],
  ])('fails closed as unavailable for %s', async (_name, response) => {
    const moderator = new DoubaoVisionModerator(
      {
        apiBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: 'not-a-real-secret',
        model: 'ep-vision-test',
      },
      async () => response,
    );
    await expect(moderator.review(input)).resolves.toEqual({
      decision: 'unavailable',
      reasonCodes: [],
    });
  });

  it('turns timeout/transport errors into unavailable without returning provider prose', async () => {
    const moderator = new DoubaoVisionModerator(
      {
        apiBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: 'not-a-real-secret',
        model: 'ep-vision-test',
      },
      async () => {
        throw new Error('provider body with private details');
      },
    );
    await expect(moderator.review(input)).resolves.toEqual({
      decision: 'unavailable',
      reasonCodes: [],
    });
  });
});
