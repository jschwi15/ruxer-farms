// Supabase project settings. The publishable key is meant to be in the browser;
// the data is protected by the database rules in setup.sql, which require the
// secret code from the app link (?k=...).
window.RUXER_CONFIG = {
  supabaseUrl: 'https://efntyjvabyfbbllrtsce.supabase.co',
  supabaseAnonKey: 'sb_publishable_-Xj1qkvMCR7ecyM347H7-w_lpLXU6E2',
  // Public half of the push-alert key pair (safe to publish).
  vapidPublicKey: 'BMPbk7hSpHFwLHey6nBVYwPS6pP_lGjFZmY74HkIZjt1uxSMxHlG_WYleWPHXdOJWmROlTmElPLMV2r-ODvphk8'
};
