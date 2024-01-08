import type { TenantGate } from '@tbd54566975/dwn-sdk-js';

import type { Dialect } from 'kysely';
import { Kysely } from 'kysely';

import { DwnServerError } from './dwn-error.js';
import { DwnServerErrorCode } from './dwn-error.js';
import { ProofOfWork } from './registration/proof-of-work.js';

const recentChallenges: { [challengeNonce: string]: number } = {};
const CHALLENGE_TIMEOUT = 5 * 60 * 1000; // challenges are valid this long after issuance
const COMPLEXITY_LOOKBACK = 5 * 60 * 1000; // complexity is based on number of successful registrations in this time frame
const COMPLEXITY_MINIMUM = BigInt('0x00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');

export class RegisteredTenantGate implements TenantGate {
  #db: Kysely<TenantRegistrationDatabase>;
  #proofOfWorkRequired: boolean;
  #termsOfServiceHash?: string;
  #termsOfService?: string;

  get termsOfService(): string {
    return this.#termsOfService;
  }

  constructor(dialect: Dialect, proofOfWorkRequired: boolean, termsOfService?: string) {
    this.#db = new Kysely<TenantRegistrationDatabase>({ dialect: dialect });
    this.#proofOfWorkRequired = proofOfWorkRequired;

    if (termsOfService) {
      this.#termsOfServiceHash = ProofOfWork.hashAsHexString([termsOfService]);
      this.#termsOfService = termsOfService;
    }
  }

  async initialize(): Promise<void> {
    setInterval(() => {
      for (const challenge of Object.keys(recentChallenges)) {
        if (recentChallenges[challenge] && Date.now() - recentChallenges[challenge] > CHALLENGE_TIMEOUT) {
          delete recentChallenges[challenge];
        }
      }
    }, CHALLENGE_TIMEOUT / 4);

    await this.#db.schema
      .createTable('authorizedTenants')
      .ifNotExists()
      .addColumn('did', 'text', (column) => column.primaryKey())
      .addColumn('proofOfWorkTime', 'timestamp')
      .addColumn('termsOfServiceHash', 'boolean')
      .execute();
  }

  async isActiveTenant(tenant: string): Promise<boolean> {
    if (!this.#proofOfWorkRequired && !this.#termsOfService) {
      return true;
    }

    const result = await this.#db
      .selectFrom('authorizedTenants')
      .select('proofOfWorkTime')
      .select('termsOfServiceHash')
      .where('did', '=', tenant)
      .execute();

    if (result.length === 0) {
      console.log('rejecting tenant that is not in the database', { tenant });
      return false;
    }

    const row = result[0];

    if (this.#termsOfService && row.termsOfServiceHash != this.#termsOfServiceHash) {
      console.log('rejecting tenant that has not accepted the current terms of service', { row, tenant, expected: this.#termsOfServiceHash });
      return false;
    }

    return true;
  }

  private async getComplexity(): Promise<bigint> {
    const result = await this.#db
      .selectFrom('authorizedTenants')
      .where('proofOfWorkTime', '>', Date.now() - COMPLEXITY_LOOKBACK)
      .select((eb) => eb.fn.countAll().as('recent_reg_count'))
      .executeTakeFirstOrThrow();
    const recentRegistrationCount = result.recent_reg_count as number;
    if (recentRegistrationCount == 0) {
      return COMPLEXITY_MINIMUM;
    }

    const complexity = COMPLEXITY_MINIMUM / BigInt(recentRegistrationCount);
    if (complexity < COMPLEXITY_MINIMUM) {
      return COMPLEXITY_MINIMUM;
    }

    return complexity;
  }

  async handleTermsOfServicePost(body: {
    did: string;
    termsOfServiceHash: string;
  }): Promise<void> {

    if (body.termsOfServiceHash != this.#termsOfServiceHash) {
      throw new DwnServerError(DwnServerErrorCode.TenantRegistrationOutdatedTermsOfService, `Outdated terms of service.`);
    }

    console.log('accepting terms of service', body);

    await this.#db
      .insertInto('authorizedTenants')
      .values({
        did: body.did,
        termsOfServiceHash: body.termsOfServiceHash,
      })
      // If a row with the same `did` already exists, it updates the `termsOfServiceHash` of the existing row
      // to the `termsOfServiceHash` of the row that was attempted to be inserted (`excluded.termsOfServiceHash`).
      .onConflict((onConflictBuilder) =>
        onConflictBuilder.column('did').doUpdateSet((expressionBuilder) => ({
          termsOfServiceHash: expressionBuilder.ref('excluded.termsOfServiceHash'),
        })),
      )
      // Executes the query. If the query doesn’t affect any rows (ie. if the insert or update didn’t change anything), it throws an error.
      .executeTakeFirstOrThrow();
  }

  async authorizeTenantTermsOfService(tenant: string): Promise<void> {
    await this.#db
      .insertInto('authorizedTenants')
      .values({
        did: tenant,
        termsOfServiceHash: this.#termsOfServiceHash,
      })
      .onConflict((onConflictBuilder) =>
        onConflictBuilder.column('did').doUpdateSet((expressionBuilder) => ({
          termsOfServiceHash: expressionBuilder.ref('excluded.termsOfServiceHash'),
        })),
      )
      // Executes the query. No error is thrown if the query doesn’t affect any rows (ie. if the insert or update didn’t change anything).
      .executeTakeFirst();
  }
}

interface AuthorizedTenants {
  did: string;
  termsOfServiceHash: string;
  proofOfWorkTime: number;
}

interface TenantRegistrationDatabase {
  authorizedTenants: AuthorizedTenants;
}