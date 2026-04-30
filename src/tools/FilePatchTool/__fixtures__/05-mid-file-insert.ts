export async function fetchUser(
  id: string,
  options?: RequestInit,
): Promise<User> {
  const response = await fetch(`/api/users/${id}`)
  return response.json()
}

export interface User {
  id: string
  name: string
  email: string
}
