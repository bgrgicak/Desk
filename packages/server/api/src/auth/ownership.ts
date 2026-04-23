import pg from "pg";
import { queries } from "@desk/db";
import { NotFoundError } from "@desk/shared";
import type { Workspace, Agent, Chat, Message } from "@desk/shared";

/**
 * Ownership checks for per-request authorization. Each helper returns the
 * authoritative row when the current user owns it, and throws NotFoundError
 * otherwise — 404, not 403, so existence of a cross-tenant resource is not
 * leaked.
 */

export async function requireOwnedWorkspace(
  pool: pg.Pool,
  workspaceId: string,
  userId: string,
): Promise<Workspace> {
  const ws = await queries.workspaces.findById(pool, workspaceId);
  if (!ws || ws.userId !== userId) {
    throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  }
  return ws;
}

export async function requireOwnedAgent(
  pool: pg.Pool,
  agentId: string,
  userId: string,
): Promise<Agent> {
  const agent = await queries.agents.findById(pool, agentId);
  if (!agent || agent.userId !== userId) {
    throw new NotFoundError(`Agent not found: ${agentId}`);
  }
  return agent;
}

export async function requireOwnedChat(
  pool: pg.Pool,
  chatId: string,
  userId: string,
): Promise<Chat> {
  const chat = await queries.chats.findById(pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);
  const ws = await queries.workspaces.findById(pool, chat.workspaceId);
  if (!ws || ws.userId !== userId) {
    throw new NotFoundError(`Chat not found: ${chatId}`);
  }
  return chat;
}

export async function requireOwnedMessage(
  pool: pg.Pool,
  chatId: string,
  messageId: string,
  userId: string,
): Promise<Message> {
  await requireOwnedChat(pool, chatId, userId);
  const msg = await queries.messages.findById(pool, messageId);
  if (!msg || msg.chatId !== chatId) {
    throw new NotFoundError(`Message not found in chat: ${messageId}`);
  }
  return msg;
}
