// Entry point of the media relay process (protocol.mjs). The server starts this file with its
// own Node executable; see media-relay.mjs.
import { runRelay } from './protocol.mjs';

runRelay();
