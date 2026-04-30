export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-xl border p-8 w-full max-w-sm">
        <h1 className="text-xl font-semibold mb-2">Cultura Hub</h1>
        <p className="text-sm text-gray-500 mb-6">Entre com sua conta Google</p>
        <button className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium">
          Entrar com Google
        </button>
      </div>
    </div>
  );
}
