'use strict';
const express=require('express');
const {chooseContextGet,chooseContextPost}=require('./guard');
const router=express.Router();
router.get('/',(req,res,next)=>Promise.resolve(chooseContextGet(req,res)).catch(next));
router.post('/',express.urlencoded({extended:false,limit:'4kb',parameterLimit:5}),(req,res,next)=>Promise.resolve(chooseContextPost(req,res)).catch(next));
module.exports=router;
