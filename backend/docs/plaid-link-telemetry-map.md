# Plaid Link Telemetry Event Map

Tiny reference for Product/Analytics to build Link conversion dashboards quickly.

## Source

- Frontend emits telemetry to `POST /api/plaid/link-telemetry`.
- Backend logs each payload as `type: 'plaid_link_telemetry'`.
- Link-native callbacks used: `onEvent`, `onExit`, `onSuccess`.

## Event Map

| event_type | When it fires | Key fields |
|---|---|---|
| `open_click` | User (or app auto-open flow) opens Plaid Link | `reason` (`connect_button`, `reconnect_button`, `auto_open_fresh_token`), `link_intent_id`, `is_update_mode` |
| `event` | Any Link `onEvent` callback | `event_name` (ex: `OPEN`, `TRANSITION_VIEW`, `SELECT_INSTITUTION`, `SUBMIT_CREDENTIALS`, `HANDOFF`, `ERROR`, `EXIT`), `view_name`, `institution_id`, `institution_name`, `link_session_id`, `request_id` |
| `exit` | Link `onExit` callback (abandon or error path) | `status`, `exit_status`, `reason`, `error_code`, `error_type`, `error_message`, `institution_id`, `link_session_id` |
| `success` | Exchange flow completes successfully (including duplicate-block path) | `reason` (`exchange_success`, `reconnect_in_place`, `duplicate_blocked`), `item_id`, `duplicate_item`, `institution_id`, `link_session_id`, `is_update_mode` |
| `failure` | Exchange flow fails, or exit includes explicit Link error | `reason`, `error_code`, `error_type`, `error_message`, `status`, `institution_id`, `link_session_id`, `is_update_mode` |

## Recommended Funnel

Use unique `link_session_id` where available.

1. **Start**: first `event` with `event_name = OPEN` (fallback: `open_click`)
2. **Institution chosen**: `event_name = SELECT_INSTITUTION`
3. **Credentials submitted**: `event_name = SUBMIT_CREDENTIALS`
4. **Handoff**: `event_name = HANDOFF`
5. **Completed in app**: `success` (`exchange_success` or `reconnect_in_place`)
6. **Abandoned/failed**: `exit` and/or `failure`

## Conversion KPIs

- **Link completion rate**: unique sessions with `HANDOFF` / unique sessions with `OPEN`
- **App exchange success rate**: `success` / (`success` + `failure`)
- **Drop-off by stage**: count last `event_name` before `exit`
- **Top failure reasons**: `error_code` and `reason`
- **Institution-level conversion**: conversion grouped by `institution_id` or `institution_name`

## Notes

- `event` ordering is best-effort; use timestamps from logs for sequencing.
- Not all payloads include `link_session_id` (for example, `open_click` pre-Link).
- `duplicate_blocked` is expected "successful prevention", not an error.
