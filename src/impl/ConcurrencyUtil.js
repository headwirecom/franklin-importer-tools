export default class ConcurrencyUtil {

    /**
     * 
     * @param {array} array - array of objects to iterate 
     * @param {function} callback - async callback function to call for each item in the array
     * @param {object} options - any object to pass back to callback 
     * @param {number} concurrency - number of objects to iterate asynchronously
     * @param {number} delay - number of milliseconds to delay processing after making a number of async calls specified by concurrency argument
     */
    static async processAll(array, callback, options = {}, concurrency = 1, delay = 200) {
        let index = 0;
        while (index < array.length) {
          const dequeue = async () => {
            for (let i = 0; i < concurrency && index < array.length; i += 1) {
              const next = array[index];
              try {
                callback(next, options, index, array);
              } catch (e) {
                console.error(e);
              }
              index++;
            }
          }
          
          dequeue();
          // console.log(`contineu processing after ${delay} milliseconds`);
          await ConcurrencyUtil.sleep(delay);
        }
      }

      static async sleep(delay) {
        return new Promise((resolve) => { setTimeout(resolve, delay) });
      }

      static waitFor(delay, condition, callback) {
        if (!condition()) {
            setTimeout(ConcurrencyUtil.waitFor, delay, delay, condition, callback);
        } else {
            setTimeout(callback, delay);
        }
      }
}