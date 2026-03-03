type Result<T> = { ok: true; value: T } | { ok: false; error: string };

type User = {
  id: string;
  name: string;
  age: number;
};

// Function returns Result<User> instead of throwing errors
function findUser(id: string): Result<User> {
  const users: User[] = [
    { id: "1", name: "Alice", age: 30 },
    { id: "2", name: "Bob", age: 25 },
  ];

  const user = users.find((u) => u.id === id);

  if (!user) {
    return { ok: false, error: `User ${id} not found` };
  }

  return { ok: true, value: user };
}

// --- calling it ---
// const result = findUser("1");
//
// if (result.ok) {
//   // narrowed to success branch — .value is a User
//   console.log(`Found: ${result.value.name}, age ${result.value.age}`);
// } else {
//   // narrowed to failure branch — .error is a string
//   console.log(`Failed: ${result.error}`);
// }

function findAndLog(id: string): void {
  const result = findUser(id);

  if (result.ok) {
    console.log(`Found: ${result.value.name}, age ${result.value.age}`);
  } else {
    console.log(`Failed: ${result.error}`);
  }
}

findAndLog("2");
