import { describe, expect, it } from 'vitest';
import { minimizeOnboardingPrompt, SanitizingOnboardingProvider } from './onboarding.provider.js';

describe('ONB provider privacy boundary', () => {
  it('omits DOB, documents, identity evidence, Dating and other sensitive mode data', () => {
    const prompt = minimizeOnboardingPrompt({
      purpose: 'discovery',
      modes: ['friends', 'dating'],
      answers: ['I was born 1990-01-02 and have a passport document.', 'I enjoy quiet book clubs'],
    });
    expect(prompt.modes).toEqual(['friends']);
    expect(prompt.answers).toEqual(['I enjoy quiet book clubs']);
    expect(JSON.stringify(prompt)).not.toMatch(/1990|passport|document|dating/i);
  });
  it('sanitizes a configured adapter immediately before invocation', async () => {
    let seen: unknown;
    const adapter = new SanitizingOnboardingProvider({
      name: 'test',
      extract: async (p) => {
        seen = p;
        return { confidence: 0.5, provenance: 'local_rules', preferences: [] };
      },
    });
    await adapter.extract({
      purpose: 'discovery',
      modes: ['dating'],
      answers: ['gender evidence', 'music'],
    });
    expect(JSON.stringify(seen)).not.toMatch(/gender|dating/i);
    expect(JSON.stringify(seen)).toContain('music');
  });
  it('drops conservative natural-language canaries, dates, document terms and numbers', () => {
    const prompt = minimizeOnboardingPrompt({
      purpose: 'profile',
      modes: ['friends'],
      answers: [
        'I like pottery and walking.',
        'Reviewer canary: my birthday is March 3, 1990.',
        'I can provide a drivers license and verification selfie.',
        'romantic dating is not part of this mode.',
        'I prefer 2 short notes weekly.',
      ],
    });
    expect(prompt.answers).toEqual(['I like pottery and walking.']);
    expect(JSON.stringify(prompt)).not.toMatch(
      /reviewer|canary|birthday|march|license|verification|selfie|romantic|dating|\d/i,
    );
  });
});
