import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const nonEmpty = z.string().trim().min(1);
const optionalTrimmed = z.string().trim().optional();
const optionalTrimmedMax = (maxLen) => z.string().trim().max(maxLen).optional();

export const schemas = {
  createLinkTokenBody: z
    .object({
      update_item_id: nonEmpty.max(128).optional(),
      account_selection_enabled: z.boolean().optional()
    })
    .strict(),
  linkTelemetryBody: z
    .object({
      event_type: z.enum(['open_click', 'event', 'exit', 'success', 'failure']),
      event_name: optionalTrimmedMax(128),
      view_name: optionalTrimmedMax(128),
      status: optionalTrimmedMax(128),
      reason: optionalTrimmedMax(256),
      institution_id: optionalTrimmedMax(128),
      institution_name: optionalTrimmedMax(256),
      link_session_id: optionalTrimmedMax(128),
      request_id: optionalTrimmedMax(128),
      error_code: optionalTrimmedMax(128),
      error_type: optionalTrimmedMax(128),
      error_message: optionalTrimmedMax(500),
      exit_status: optionalTrimmedMax(128),
      link_intent_id: optionalTrimmedMax(128),
      item_id: optionalTrimmedMax(128),
      duplicate_item: z.boolean().optional(),
      is_update_mode: z.boolean().optional(),
      metadata: z.record(z.string(), z.any()).optional()
    })
    .strict(),
  exchangeTokenBody: z
    .object({
      public_token: nonEmpty.max(512),
      link_intent_id: nonEmpty.max(128).optional(),
      reconnect_item_id: nonEmpty.max(128).optional(),
      link_success_metadata: z
        .object({
          institution_id: optionalTrimmed,
          institution_name: optionalTrimmedMax(256),
          link_session_id: optionalTrimmed,
          accounts: z
            .array(
              z.object({
                name: optionalTrimmed,
                mask: optionalTrimmed,
                type: optionalTrimmed,
                subtype: optionalTrimmed
              }).strict()
            )
            .optional()
        })
        .strict()
        .optional()
    })
    .strict(),
  reconnectInPlaceBody: z
    .object({
      old_item_id: nonEmpty.max(128),
      new_item_id: nonEmpty.max(128)
    })
    .strict(),
  plaidItemBody: z
    .object({
      item_id: nonEmpty.max(128)
    })
    .strict(),
  plaidAccountBody: z
    .object({
      plaid_account_id: nonEmpty.max(128)
    })
    .strict(),
  transactionsSyncBody: z
    .object({
      item_id: nonEmpty.max(128).optional(),
      force_refresh: z.boolean().optional(),
      user_initiated: z.boolean().optional()
    })
    .strict(),
  plaidTransactionsBody: z
    .object({
      item_id: nonEmpty.max(128),
      start_date: isoDate,
      end_date: isoDate
    })
    .strict(),
  historyNetWorthQuery: z
    .object({
      start_date: isoDate.optional(),
      end_date: isoDate.optional()
    })
    .strict(),
  historyNetWorthTmmQuery: z
    .object({
      start_date: isoDate.optional(),
      end_date: isoDate.optional(),
      alt_names: z.string().trim().optional()
    })
    .strict(),
  historyNetWorthBody: z
    .object({
      start_date: isoDate.optional().nullable(),
      end_date: isoDate.optional().nullable(),
      checkpoints: z
        .array(
          z.object({
            date: isoDate,
            netWorth: z.number().finite(),
            source: z.string().optional(),
            confidence: z.string().optional()
          })
        )
        .optional(),
      threshold: z.number().finite().nonnegative().optional()
    })
    .strict(),
  historyNetWorthTmmUpsertBody: z
    .object({
      points: z.array(
        z.object({
          alt: nonEmpty.max(128),
          net_worth: z.number().finite()
        }).strict()
      ).min(1),
      as_of: z.string().datetime().optional()
    })
    .strict(),
  historyReconciliationBody: z
    .object({
      point_date: isoDate,
      chosen_source: z.enum(['checkpoint', 'plaid']),
      checkpoint_value: z.number().finite().optional(),
      plaid_value: z.number().finite().optional(),
      reason: z.string().max(500).optional()
    })
    .strict(),
  historyArchiveBody: z
    .object({
      use_month_end: z.boolean().optional()
    })
    .strict(),
  privacyConsentBody: z
    .object({
      consent_type: z.enum(['plaid_data_processing']),
      policy_version: nonEmpty.max(64),
      accepted: z.boolean()
    })
    .strict(),
  deleteAccountBody: z
    .object({
      confirm_text: z.string().trim().min(1),
      reason: z.string().max(500).optional()
    })
    .strict(),
  mfaRemoveFactorBody: z
    .object({
      factor_id: nonEmpty.max(64)
    })
    .strict()
};

function validationErrorToResponse(err) {
  return err.issues?.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message
  })) || [{ path: '(unknown)', message: 'Invalid request payload' }];
}

export function validateBody(schema) {
  return function bodyValidator(req, res, next) {
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        issues: validationErrorToResponse(parsed.error)
      });
    }
    req.body = parsed.data;
    return next();
  };
}

export function validateQuery(schema) {
  return function queryValidator(req, res, next) {
    const parsed = schema.safeParse(req.query || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid query parameters',
        issues: validationErrorToResponse(parsed.error)
      });
    }
    req.query = parsed.data;
    return next();
  };
}
