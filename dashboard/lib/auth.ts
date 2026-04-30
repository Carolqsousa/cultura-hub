export async function getUser() {
  return { name: "Carol Sousa", email: "carol@culturainglesa.com.br", branch: "all" };
}

export function branchFilter(branch: string) {
  if (branch === "all") return "";
  return `AND branch = '${branch}'`;
}
