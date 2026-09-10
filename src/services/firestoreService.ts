import { Firestore, FieldValue } from '@google-cloud/firestore';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Firestore with explicit credentials path fallback
const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || 
  path.resolve(process.cwd(), 'our-tracker-503004-a7-7bfd1d9819e2.json');

export const firestore = new Firestore({
  keyFilename: credsPath,
  ignoreUndefinedProperties: true,
  // High-performance gRPC settings for HTTP/2 connection pooling & keep-alive
  clientConfig: {
    'grpc.keepalive_time_ms': 30000,
    'grpc.keepalive_timeout_ms': 10000,
    'grpc.keepalive_permit_without_calls': 1,
    'grpc.http2.max_pings_without_data': 0,
  },
});

export interface OrderData {
  id?: string;
  orderNumber: string;
  creatorId: string;
  creatorName: string;
  side: 'high' | 'low' | string;
  amount: number;
  rangeMin?: number;
  rangeMax?: number;
  rocketName?: string;
  groupId?: string;
  status: 'OPEN' | 'MATCHED' | 'CANCELLED' | 'RESOLVED' | 'VOIDED';
  matchedUserId?: string | null;
  matchedUserName?: string | null;
  createdAt?: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp | Date | string;
  matchedAt?: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp | Date | string | null;
}

const ORDERS_COLLECTION = 'orders';

// In-memory store fallback when Firestore API is unreachable or disabled
export const inMemoryOrders = new Map<string, OrderData>();

/**
 * Save a new betting order with status 'OPEN'.
 */
export async function createOrder(
  orderData: Omit<OrderData, 'status' | 'orderNumber'> & { orderNumber?: string }
): Promise<OrderData & { id: string }> {
  const collectionRef = firestore.collection(ORDERS_COLLECTION);
  const docRef = collectionRef.doc();
  
  const orderNumber = orderData.orderNumber || (Math.floor(Math.random() * 900000) + 100000).toString();

  const newOrder: OrderData = {
    ...orderData,
    id: docRef.id,
    orderNumber,
    status: 'OPEN',
    matchedUserId: null,
    matchedUserName: null,
    createdAt: FieldValue.serverTimestamp(),
    matchedAt: null
  };

  // Always keep in-memory cache populated
  inMemoryOrders.set(docRef.id, newOrder);
  inMemoryOrders.set(orderNumber, newOrder);

  try {
    await docRef.set(newOrder);
  } catch (err: any) {
    console.warn(`[FirestoreService] Firestore write failed (${err?.message || err}). Order #${orderNumber} retained in memory.`);
  }

  return { ...newOrder, id: docRef.id };
}

/**
 * Match an open order using Firestore Transactions (Atomic Locks) to prevent race conditions.
 */
export async function matchOrderTransaction(
  orderId: string,
  userId: string,
  userName: string = 'ผู้เล่น'
): Promise<{ success: boolean; order: OrderData }> {
  // Resolve docRef - support both Firestore doc ID and orderNumber field
  let orderRef = firestore.collection(ORDERS_COLLECTION).doc(orderId);
  const initialCheck = await orderRef.get();
  if (!initialCheck.exists) {
    const querySnapshot = await firestore
      .collection(ORDERS_COLLECTION)
      .where('orderNumber', '==', orderId)
      .limit(1)
      .get();
    if (!querySnapshot.empty) {
      orderRef = querySnapshot.docs[0].ref;
    }
  }

  return await firestore.runTransaction(async (transaction) => {
    const orderDoc = await transaction.get(orderRef);

    if (!orderDoc.exists) {
      throw new Error(`ORDER_NOT_FOUND: Order #${orderId} does not exist`);
    }

    const order = orderDoc.data() as OrderData;

    // Disallow self-matching
    if (order.creatorId === userId) {
      throw new Error(`CANNOT_MATCH_OWN_ORDER: Order #${order.orderNumber} cannot be matched by its creator`);
    }

    // Atomic race-condition lock: verify order is still strictly 'OPEN'
    if (order.status === 'MATCHED') {
      throw new Error(`ALREADY_MATCHED: Order #${order.orderNumber} has already been matched by someone else`);
    }

    if (order.status !== 'OPEN') {
      throw new Error(`ORDER_NOT_AVAILABLE: Order #${order.orderNumber} status is ${order.status}`);
    }

    // Mutate state atomically
    transaction.update(orderRef, {
      status: 'MATCHED',
      matchedUserId: userId,
      matchedUserName: userName,
      matchedAt: FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      order: {
        ...order,
        status: 'MATCHED',
        matchedUserId: userId,
        matchedUserName: userName,
      }
    };
  });
}

/**
 * Retrieve an order by document ID or orderNumber.
 */
export async function getOrder(orderIdOrNumber: string): Promise<OrderData | null> {
  if (inMemoryOrders.has(orderIdOrNumber)) {
    return inMemoryOrders.get(orderIdOrNumber)!;
  }

  try {
    const docRef = firestore.collection(ORDERS_COLLECTION).doc(orderIdOrNumber);
    const doc = await docRef.get();
    if (doc.exists) {
      return { id: doc.id, ...(doc.data() as OrderData) };
    }

    // Fallback lookup by orderNumber field
    const snapshot = await firestore
      .collection(ORDERS_COLLECTION)
      .where('orderNumber', '==', orderIdOrNumber)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const matchedDoc = snapshot.docs[0];
      return { id: matchedDoc.id, ...(matchedDoc.data() as OrderData) };
    }
  } catch (err: any) {
    console.warn(`[FirestoreService] Firestore getOrder lookup failed (${err?.message || err}). Returning in-memory fallback.`);
  }

  return inMemoryOrders.get(orderIdOrNumber) || null;
}
