const DB_NAME = 'device-mapping-mvp'
const DB_VERSION = 1
const KEYFRAME_STORE = 'keyframes'
const OBJECT_STORE = 'objects'

const openDb = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION)

  request.onupgradeneeded = () => {
    const db = request.result

    if (!db.objectStoreNames.contains(KEYFRAME_STORE)) {
      db.createObjectStore(KEYFRAME_STORE, {keyPath: 'id'})
    }

    if (!db.objectStoreNames.contains(OBJECT_STORE)) {
      db.createObjectStore(OBJECT_STORE, {keyPath: 'id'})
    }
  }

  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const transact = async (storeName, mode, callback) => {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)
    const result = callback(store)

    tx.oncomplete = () => {
      db.close()
      resolve(result)
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

const requestAll = (store) => new Promise((resolve, reject) => {
  const request = store.getAll()
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

export const saveKeyframe = (keyframe) => transact(KEYFRAME_STORE, 'readwrite', (store) => {
  store.put(keyframe)
})

export const loadKeyframes = () => transact(KEYFRAME_STORE, 'readonly', requestAll)

export const saveObjectPose = (objectPose) => transact(OBJECT_STORE, 'readwrite', (store) => {
  store.put(objectPose)
})

export const loadObjects = () => transact(OBJECT_STORE, 'readonly', requestAll)

export const clearObjects = () => transact(OBJECT_STORE, 'readwrite', (store) => store.clear())

export const clearSpatialMemory = async () => {
  await transact(KEYFRAME_STORE, 'readwrite', (store) => store.clear())
  await transact(OBJECT_STORE, 'readwrite', (store) => store.clear())
}
