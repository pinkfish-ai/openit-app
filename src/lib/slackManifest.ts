// Source of truth for the Slack app manifest the admin pastes into
// api.slack.com → Create New App → From an app manifest. Lives in a
// dedicated module (rather than inline in the modal/canvas) so the
// Copy action and any tests reach for the same string. Keep this in
// sync with the YAML embedded in connect-slack.md (which is for
// human reference only — the modal/canvas is the canonical copy
// path).

export const SLACK_APP_MANIFEST = `display_information:
  name: OpenIT
  description: Local IT helpdesk bot
  background_color: "#2c2d72"
features:
  bot_user:
    display_name: OpenIT
    always_online: false
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - im:read
      - im:write
      - users:read
      - users:read.email
      - team:read
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;
