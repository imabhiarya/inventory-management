import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ROLES } from '../config/constants.js';

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    designation: { type: String, trim: true, default: '' },
    role: { type: String, enum: ROLES, default: 'storekeeper' },
    passwordHash: { type: String, required: true },
    active: { type: Boolean, default: true },
    // Incremented on password change / deactivation to invalidate existing sessions.
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.methods.verifyPassword = function verifyPassword(password) {
  return bcrypt.compare(password, this.passwordHash);
};

userSchema.statics.hashPassword = (password) => bcrypt.hash(password, 12);

userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    username: this.username,
    name: this.name,
    designation: this.designation,
    role: this.role,
    active: this.active,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt,
  };
};

export default mongoose.model('User', userSchema);
