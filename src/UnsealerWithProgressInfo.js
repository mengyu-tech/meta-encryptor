import keccak256 from "keccak256";
import ByteBuffer, {
  LITTLE_ENDIAN
} from "bytebuffer";

import {
  buffer2header_t,
  ntpackage2batch,
  fromNtInput,
} from "./header_util.js"
const {
  Transform
} = require('stream');
var log = require("loglevel").getLogger("meta-encryptor/UnsealerWithProgressInfo");

import{HeaderSize, MagicNum, CurrentBlockFileVersion} from "./limits.js";

import YPCCryptoFun from "./ypccrypto.js";
const YPCCrypto = YPCCryptoFun();

export class UnsealerWithProgressInfo extends Transform{
  constructor(options) {
    super({...options, objectMode: true});
    this.accumulatedBuffer = Buffer.alloc(0);
    this.keyPair = options.keyPair;
    this.progressHandler = options.progressHandler;
    this.isHeaderReady = false;
    this.dataHash = keccak256(Buffer.from("Fidelius", "utf-8"));
    this.readItemCount = options ? (options.processedItemCount || 0) : 0;
    this.processedBytes = options ? options.processedBytes || 0 : 0;
    this.writeBytes = options ? (options.writeBytes || 0) : 0;
    log.debug("UnsealerWithProgressInfo : ", this)
  }

  _transform(chunk, encoding, callback) {
    //log.debug("enter transform")
    this.accumulatedBuffer = Buffer.concat([this.accumulatedBuffer, chunk]);
    log.debug("accu buffer " + this.accumulatedBuffer.length)
    try{
      if(!this.isHeaderReady){
        if(this.accumulatedBuffer.length >= HeaderSize){
          const header = this.accumulatedBuffer.slice(0, HeaderSize);
          this.header = buffer2header_t(ByteBuffer.wrap(header, LITTLE_ENDIAN));
          if (this.header.version_number != CurrentBlockFileVersion) {
            callback(new Error("only support version ", CurrentBlockFileVersion, ", yet got ", header.version_number));
            return ;
          }
          if(!this.header.magic_number.equals(MagicNum)){
            callback(new Error("Invalid magic number, maybe wrong file"));
            return ;
          }
          this.accumulatedBuffer = this.accumulatedBuffer.slice(HeaderSize);
          this.isHeaderReady = true;
          log.debug("header is ready")
          log.debug("total item number: ", this.header.item_number)
        }
      }
    }catch(err){
      log.error("err " + err)
      callback(err);
      return ;
    }

    try{

      if(this.isHeaderReady){
        while(this.accumulatedBuffer.length > 8){
          log.debug("got enough bytes ", this.accumulatedBuffer.length)
          let offset = 0;
          let buf = ByteBuffer.wrap(this.accumulatedBuffer.slice(0, 8), LITTLE_ENDIAN);
          let item_size = buf.readUint64(offset).toNumber()
          log.debug("item_size toNumber()", item_size)
          offset += 8;
          if(this.accumulatedBuffer.length >= item_size + offset){
            log.debug("got enough data ", item_size)
            let cipher = this.accumulatedBuffer.slice(offset, offset + item_size);
            log.debug("offset + item_size: ", offset + item_size)
            log.debug("this.processedBytes: ", this.processedBytes)
            this.processedBytes = this.processedBytes + (offset + item_size);
            log.debug("this.processedBytes: ", this.processedBytes)
            this.accumulatedBuffer = this.accumulatedBuffer.slice(offset + item_size);

            let msg = YPCCrypto.decryptMessage(Buffer.from(this.keyPair["private_key"], 'hex'), cipher);
            //TODO check if msg is null, i.e., decrypt failed
            let batch = ntpackage2batch(msg);
            log.debug("got batch with length " + batch.length)
            let input = Buffer.alloc(0);
            for(let i = 0; i < batch.length; i++){
              //log.debug("start from n")
              let b = fromNtInput(batch[i]);
              //log.debug("end from n")
              log.debug("b", b)
              input = Buffer.concat([input, b])
              log.debug("input", input)
              this.writeBytes += b.length;

              let k = Buffer.from(
                this.dataHash.toString("hex") + Buffer.from(batch[i]).toString("hex"),
                "hex"
              );
             this.dataHash = keccak256(k);
            }
            this.readItemCount += 1;
            this.push({
              chunk: input,
              processedBytes: this.processedBytes,
              readItemCount: this.readItemCount,
              totalItem: this.header.item_number
            })
            log.debug('this.push', {
              chunk: input,
              processedBytes: this.processedBytes,
              readItemCount: this.readItemCount
            })
            if(this.progressHandler !== undefined &&
              this.progressHandler !== null){
              this.progressHandler(this.header.item_number, this.readItemCount, this.processedBytes, this.writeBytes);
            }
            if(this.readItemCount === this.header.item_number){
              log.debug('push(null)')
              this.push(null);
            }
          }else{
            break;
          }
        }
      }
      callback();
    }catch(err){
      log.error("err " + err)
      callback(err);
    }
  }

  _flush(callback) {
    callback();
  }
}
