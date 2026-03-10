import { Schema, model } from "mongoose";

const tokenSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    accessToken: {
      type: String,
      required: true,
    },
    refreshToken: String,
    expiresAt: Date,
  },
  { timestamps: true }
);

export const Token = model("Token", tokenSchema);