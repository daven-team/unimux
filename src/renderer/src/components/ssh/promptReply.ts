// The answer to a login prompt without its target: a cell sends it with its cell id, the SFTP view with its session id.
import type { SshPromptAnswer } from '../../../../shared/ssh';

type WithoutCell<T> = T extends { cellId: string } ? Omit<T, 'cellId'> : never;
export type PromptReply = WithoutCell<SshPromptAnswer>;

export const promptReply = (cellId: string) => (reply: PromptReply): void => { void window.mc.ssh.answer({ ...reply, cellId } as SshPromptAnswer); };
export const sftpPromptReply = (sessionId: string) => (reply: PromptReply): void => { void window.mc.sftp.answer({ ...reply, sessionId }); };
