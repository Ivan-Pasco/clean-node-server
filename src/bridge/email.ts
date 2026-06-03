import * as nodemailer from 'nodemailer';
import { WasmState } from '../types';
import { readString, writeString } from './helpers';

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
}

let smtpConfig: SmtpConfig | null = null;
let lastEmailError = '';

export function createEmailBridge(getState: () => WasmState) {
  return {
    /**
     * Store SMTP configuration — called once during startup from a mail: block
     */
    _email_configure(
      hostPtr: number, hostLen: number,
      port: bigint,
      secure: number,
      userPtr: number, userLen: number,
      passPtr: number, passLen: number,
      fromPtr: number, fromLen: number
    ): void {
      const state = getState();
      smtpConfig = {
        host: readString(state, hostPtr, hostLen),
        port: Number(port),
        secure: secure !== 0,
        username: readString(state, userPtr, userLen),
        password: readString(state, passPtr, passLen),
        fromAddress: readString(state, fromPtr, fromLen),
      };
    },

    /**
     * Send email via SMTP — fires async, returns 1 optimistically.
     * _email_last_error reflects the outcome of the most recently completed send.
     */
    _email_send(
      toPtr: number, toLen: number,
      subjectPtr: number, subjectLen: number,
      htmlPtr: number, htmlLen: number,
      textPtr: number, textLen: number,
      fromOverridePtr: number, fromOverrideLen: number
    ): number {
      if (!smtpConfig) {
        lastEmailError = 'SMTP not configured — call email.configure first';
        return 0;
      }

      const state = getState();
      const to = readString(state, toPtr, toLen);
      const subject = readString(state, subjectPtr, subjectLen);
      const html = readString(state, htmlPtr, htmlLen);
      const text = readString(state, textPtr, textLen);
      const fromOverride = readString(state, fromOverridePtr, fromOverrideLen);
      const from = fromOverride || smtpConfig.fromAddress;

      const config = smtpConfig;
      const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.username
          ? { user: config.username, pass: config.password }
          : undefined,
      });

      transport.sendMail({ from, to, subject, html, text }).then(() => {
        lastEmailError = '';
      }).catch((err: Error) => {
        lastEmailError = err.message;
      });

      return 1;
    },

    /**
     * Return error from the last _email_send attempt (empty string = success)
     */
    _email_last_error(): number {
      const state = getState();
      return writeString(state, lastEmailError);
    },
  };
}
