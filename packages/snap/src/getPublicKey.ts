import { Wallet } from '@astrox/ord-snap-types';
import { getIdentity } from './getIdentity';
import { SchorrIdentity, toHexString } from './util';
import { SnapsGlobalObject } from '@metamask/snaps-types';

export async function getRawPublicKey(wallet: SnapsGlobalObject): Promise<string> {
  const identityString = await getIdentity(wallet);
  const identity = SchorrIdentity.fromJSON(identityString);
  const rawPublicKey = identity.getPublicKey().toRaw();
  return toHexString(rawPublicKey);
}