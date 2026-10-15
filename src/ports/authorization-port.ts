/**
 * Authorization: the one way a credential reaches the host by talking to the human.
 *
 * A key that configuration cannot supply has to be asked for, and the ask is the dangerous part: the answer must
 * reach the host's own credential store and stop there. This port is deliberately shaped so it cannot leak - the
 * request carries no secret, and the outcome carries a masked form, never the credential itself. The model therefore
 * learns that a credential is stored and what it looks like, and never what it is.
 */
export type AiCoderAuthorizationRequest = Readonly<{
  /** Host-owned name of the credential, e.g. `provider.apiKey`. */
  credential: string;
  /** What the human is being asked for, in their language. */
  message: string;
  /** Optional example of the expected shape, shown beside the masked input. */
  placeholder?: string;
}>;

export type AiCoderAuthorizationOutcome = Readonly<{
  /** The credential name, echoed so a caller can report it. */
  credential: string;
  /** A masked form for display, e.g. `sk-…a91f`. Never the credential. */
  masked: string;
}>;

export interface AiCoderAuthorizationPort {
  /**
   * Ask the human for a secret and store it in the host's credential store.
   *
   * Implementations must mask the input, keep it out of every log and transcript, and resolve `null` when the human
   * declines. The secret is never returned: a caller cannot leak what it never received.
   */
  requestSecret(request: AiCoderAuthorizationRequest): Promise<AiCoderAuthorizationOutcome | null>;
}
