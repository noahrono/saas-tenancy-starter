import type { FastifyBaseLogger } from 'fastify';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Development mailer: writes each email to the log instead of sending it. */
export function consoleMailer(log: Pick<FastifyBaseLogger, 'info'>): Mailer {
  return {
    async send(msg) {
      log.info({ mail: msg }, `email to ${msg.to}: ${msg.subject}`);
    },
  };
}
