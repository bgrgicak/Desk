/**
 * Body returned by the GET / health endpoint.
 *
 * Extracted into its own file so the dev-override e2e test can mutate this
 * value to verify tsx-watch reload behaviour without touching the real
 * server source (app.ts). A mid-test crash that fails to restore this file
 * leaves only an easily-spotted scratch value — not a corrupt application.
 */
export const HEALTH_MESSAGE = "hello world";
