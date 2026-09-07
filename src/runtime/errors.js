/**
 * Error classes — mirrors @jackwener/opencli/errors surface so unmodified
 * opencli adapters can `import { ... } from '@jackwener/opencli/errors'`
 * (resolved here via the Vite alias in vite.config.ts) and construct them
 * with opencli's exact signatures.
 *
 * Source of truth: opencli/src/errors.ts (v1.8.0). Constructor argument
 * shapes are kept byte-compatible. Two of our own runtime consumers read
 * extra fields off these errors (dispatcher.ts reads `.source` on
 * EmptyResultError and `.domain` on AuthRequiredError); those are preserved
 * as compatibility shims so swapping in opencli's signatures doesn't break
 * our classifyError path.
 */

export class CliError extends Error {
  constructor(code, message, help, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.help = help;
    this.exitCode = exitCode;
  }
}

export class ArgumentError extends CliError {
  constructor(message, help) {
    super('ARGUMENT', message, help, 2);
    this.name = 'ArgumentError';
  }
}

export class TimeoutError extends CliError {
  constructor(message, help) {
    super('TIMEOUT', message, help);
    this.name = 'TimeoutError';
  }
}

function looksLikeDomain(value) {
  return /^[^\s]+\.[^\s]+$/.test(value) || (!value.includes(' ') && value.length < 30 && !value.includes('.'));
}

export class AuthRequiredError extends CliError {
  constructor(domainOrMessage, helpOrMessage, maybeHelp) {
    // Mirrors opencli's disambiguation: support both
    //   new AuthRequiredError(domain, message)   ← our vendored adapters
    //   new AuthRequiredError(message)
    let domain;
    let message;
    let help;
    if (
      maybeHelp !== undefined ||
      (helpOrMessage !== undefined && domainOrMessage !== undefined && looksLikeDomain(domainOrMessage))
    ) {
      domain = domainOrMessage;
      message = helpOrMessage ?? `Authentication required for ${domain}`;
      help = maybeHelp;
    } else if (helpOrMessage !== undefined && domainOrMessage !== undefined) {
      if (looksLikeDomain(domainOrMessage)) {
        domain = domainOrMessage;
        message = helpOrMessage;
      } else {
        message = domainOrMessage;
        help = helpOrMessage;
      }
    } else {
      if (domainOrMessage && looksLikeDomain(domainOrMessage)) {
        domain = domainOrMessage;
        message = `Authentication required for ${domain}`;
      } else {
        message = domainOrMessage ?? 'Authentication required';
      }
    }
    super('AUTH_REQUIRED', message, help, 4);
    this.name = 'AuthRequiredError';
    this.domain = domain;
  }
}

export class EmptyResultError extends CliError {
  // This project's convention is (source, message) and dispatcher.ts reads
  // `.source`; the existing errors.test.ts pins this shape. opencli's own
  // adapters call (command, hint) — under our shape the hint just becomes the
  // message, which still constructs fine and reads sensibly in the dispatcher.
  constructor(source, message) {
    super('EMPTY_RESULT', message ?? `${source} returned no data`, undefined, 5);
    this.name = 'EmptyResultError';
    this.source = source;
  }
}

export class BrowserConnectError extends CliError {
  constructor(message, help) {
    super('BROWSER_CONNECT', message, help, 6);
    this.name = 'BrowserConnectError';
  }
}

export class ConfigError extends CliError {
  constructor(message, help) {
    super('CONFIG', message, help, 7);
    this.name = 'ConfigError';
  }
}

export class CommandExecutionError extends CliError {
  constructor(message, help) {
    super('COMMAND_EXEC', message, help, 8);
    this.name = 'CommandExecutionError';
  }
}

export class LoginWallError extends CliError {
  constructor(message, status, url, bodyPreview, help) {
    super('LOGIN_WALL', message, help, 9);
    this.name = 'LoginWallError';
    this.status = status;
    this.url = url;
    this.bodyPreview = bodyPreview;
  }
}

/**
 * Thrown when the site detected automation / rate-limited the request and
 * redirected to a captcha or verification flow. The agent loop treats this
 * specially: it stops execution immediately rather than retrying, to avoid
 * escalation to a hard account ban.
 */
export class RateLimitedError extends CliError {
  constructor(domain, redirectedUrl, message, help) {
    super('RATE_LIMITED', message ?? `Rate limited by ${domain}`, help, 10);
    this.name = 'RateLimitedError';
    this.domain = domain;
    this.redirectedUrl = redirectedUrl;
  }
}

/**
 * Thrown when an adapter needs the user to attach files (images) via the
 * side-panel UI before it can proceed. The agent loop catches this and
 * surfaces an inline upload card.
 */
export class NeedsAttachmentsError extends CliError {
  constructor(opts = {}) {
    const min = opts.minImages ?? 1;
    const max = opts.maxImages ?? 9;
    super('NEEDS_ATTACHMENTS', opts.message ?? `Needs ${min}-${max} image attachments`, opts.help, 11);
    this.name = 'NeedsAttachmentsError';
    this.minImages = min;
    this.maxImages = max;
  }
}

export class NotImplementedError extends CliError {
  constructor(message, help) {
    super('NOT_IMPLEMENTED', message, help, 12);
    this.name = 'NotImplementedError';
  }
}

export class NavigationError extends CliError {
  constructor(message, help) {
    super('NAVIGATION_ERROR', message, help, 13);
    this.name = 'NavigationError';
  }
}

export class ResourceConflictError extends CliError {
  constructor(message, help) {
    super('RESOURCE_CONFLICT', message, help, 14);
    this.name = 'ResourceConflictError';
  }
}

export class BugError extends CliError {
  constructor(message, help) {
    super('BUG', message, help, 99);
    this.name = 'BugError';
  }
}
