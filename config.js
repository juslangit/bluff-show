/* Room mode settings.
   Fill these in from the Supabase dashboard: Project Settings -> API Keys.
   The publishable key is designed to sit in web pages (it is not a secret),
   and this project has no tables, so the key can only relay game messages.
   Leave them empty and the game still works in pass-one-device mode. */
window.BLUFF_CONFIG = {
  supabaseUrl: '',
  supabaseKey: '',
};
