// Wasabi Saver — configuration.
//
// Zero-config: this is already pointed at your live tool. You normally don't
// need to touch anything. If you ever move the tool to a different domain,
// just change TOOL_ORIGIN below (no trailing slash).
//
// SUPABASE_URL / SUPABASE_ANON_KEY are the PUBLIC anon credentials (the same
// ones shipped in the web app's client bundle). They're only used to refresh
// an expired access token via the refresh_token grant — safe to embed.
globalThis.WASABI_CONFIG = {
  TOOL_ORIGIN: 'https://cute-cupcake-74bad8.netlify.app',
  SUPABASE_URL: 'https://sktpbizpckxldhxzezws.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
};
