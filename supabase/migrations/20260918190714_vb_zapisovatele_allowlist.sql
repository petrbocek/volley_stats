CREATE TABLE IF NOT EXISTS vb_zapisovatele (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  poznamka text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE vb_zapisovatele ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.je_zapisovatel() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$ SELECT EXISTS (SELECT 1 FROM public.vb_zapisovatele z WHERE z.user_id = auth.uid()) $$;

INSERT INTO vb_zapisovatele (user_id, poznamka)
SELECT id, 'majitel projektu' FROM auth.users WHERE email = 'petrbocek@email.cz'
ON CONFLICT (user_id) DO NOTHING;
