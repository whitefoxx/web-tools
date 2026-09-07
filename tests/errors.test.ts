import { describe, it, expect } from 'vitest';
import {
  CliError,
  AuthRequiredError,
  EmptyResultError,
  ArgumentError,
  RateLimitedError,
} from '../src/runtime/errors.js';

describe('CliError', () => {
  it('extends Error and carries code/message/help', () => {
    const e = new CliError('FOO', 'something bad', 'try again');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('FOO');
    expect(e.message).toBe('something bad');
    expect(e.help).toBe('try again');
    expect(e.name).toBe('CliError');
  });
});

describe('AuthRequiredError', () => {
  it('extends CliError, has AUTH_REQUIRED code and carries domain', () => {
    const e = new AuthRequiredError('xiaohongshu.com', 'need login');
    expect(e).toBeInstanceOf(CliError);
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.code).toBe('AUTH_REQUIRED');
    expect(e.domain).toBe('xiaohongshu.com');
    expect(e.message).toContain('need login');
    expect(e.name).toBe('AuthRequiredError');
  });

  it('uses a default message when none supplied', () => {
    const e = new AuthRequiredError('foo.com');
    expect(e.message.length).toBeGreaterThan(0);
  });
});

describe('EmptyResultError', () => {
  it('has EMPTY_RESULT code and carries source', () => {
    const e = new EmptyResultError('xiaohongshu/search', 'no hits');
    expect(e).toBeInstanceOf(CliError);
    expect(e.code).toBe('EMPTY_RESULT');
    expect(e.source).toBe('xiaohongshu/search');
    expect(e.message).toBe('no hits');
  });
});

describe('ArgumentError', () => {
  it('has ARGUMENT code', () => {
    const e = new ArgumentError('bad input');
    expect(e).toBeInstanceOf(CliError);
    expect(e.code).toBe('ARGUMENT');
    expect(e.message).toBe('bad input');
    expect(e.name).toBe('ArgumentError');
  });
});

describe('RateLimitedError', () => {
  it('has RATE_LIMITED code and carries domain + redirectedUrl', () => {
    const e = new RateLimitedError(
      'xiaohongshu.com',
      'https://www.xiaohongshu.com/website-login/captcha?verifyType=124',
      'Site is rate-limiting',
    );
    expect(e).toBeInstanceOf(CliError);
    expect(e).toBeInstanceOf(RateLimitedError);
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.domain).toBe('xiaohongshu.com');
    expect(e.redirectedUrl).toContain('website-login');
    expect(e.name).toBe('RateLimitedError');
  });

  it('uses a sensible default message', () => {
    const e = new RateLimitedError('xhs.com', 'https://x/captcha');
    expect(e.message.length).toBeGreaterThan(0);
  });
});
