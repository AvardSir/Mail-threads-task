// src/test-client.ts
import { fetchMessages } from './client';

async function test() {
  try {
    const result = await fetchMessages(undefined, 1);
    console.log('Items count:', result.items.length);
    console.log('Next cursor:', result.next_cursor);
    if (result.items.length > 0) {
      console.log('First item:', JSON.stringify(result.items[0], null, 2));
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

test();